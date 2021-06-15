'use strict';

const config = require('wild-config');
const ACME = require('@root/acme');
const { pem2jwk } = require('pem-jwk');
const CSR = require('@root/csr');
const { Certificate } = require('@fidm/x509');
const AcmeChallenge = require('./acme-challenge');
const pkg = require('../../package.json');
const { normalizeDomain } = require('../tools');
const Lock = require('ioredfour');
const util = require('util');
const log = require('npmlog');
const { Resolver } = require('dns').promises;
const resolver = new Resolver();
const Joi = require('joi');
const CertHandler = require('../cert-handler');
const db = require('../db');

if (config.resolver && config.resolver.ns && config.resolver.ns.length) {
    resolver.setServers([].concat(config.resolver.ns || []));
}

const RENEW_AFTER_REMAINING = 10000 + 30 * 24 * 3600 * 1000;
const BLOCK_RENEW_AFTER_ERROR_TTL = 10; //3600;

const acme = ACME.create({
    maintainerEmail: pkg.author.email,
    packageAgent: pkg.name + '/' + pkg.version,
    notify(ev, params) {
        log.info('ACME', 'Notification for %s (%s)', ev, JSON.stringify(params));
    }
});

let getLock, releaseLock;

let certHandler;

// First try triggers initialization, others will wait until first is finished
let acmeInitialized = false;
let acmeInitializing = false;
let acmeInitPending = [];

const ensureAcme = async acmeOptions => {
    if (acmeInitialized) {
        return true;
    }
    if (acmeInitializing) {
        return new Promise((resolve, reject) => {
            acmeInitPending.push({ resolve, reject });
        });
    }

    try {
        await acme.init(acmeOptions.directoryUrl);
        acmeInitialized = true;

        if (acmeInitPending.length) {
            for (let entry of acmeInitPending) {
                entry.resolve(true);
            }
        }
    } catch (err) {
        if (acmeInitPending.length) {
            for (let entry of acmeInitPending) {
                entry.reject(err);
            }
        }
        throw err;
    } finally {
        acmeInitializing = false;
    }

    return true;
};

const getAcmeAccount = async acmeOptions => {
    await ensureAcme(acmeOptions);

    const entryKey = `acme:account:${acmeOptions.key}`;

    const settingsValue = await db.database.collection('settings').findOne({ key: entryKey });
    // there is already an existing acme account, no need to create a new one
    if (settingsValue && settingsValue.value) {
        return settingsValue.value;
    }

    // account not found, create a new one
    log.info('ACME', 'ACME account for %s not found, provisioning new one from %s', acmeOptions.key, acmeOptions.directoryUrl);
    const accountKey = await certHandler.generateKey(acmeOptions.keyBits, acmeOptions.keyExponent);

    const jwkAccount = pem2jwk(accountKey);
    log.info('ACME', 'Generated Acme account key for %s', acmeOptions.key);

    const accountOptions = {
        subscriberEmail: acmeOptions.email,
        agreeToTerms: true,
        accountKey: jwkAccount
    };

    const account = await acme.accounts.create(accountOptions);

    const r = await db.database.collection('settings').insertOne({
        key: entryKey,
        value: {
            key: accountKey,
            account
        },
        enumerable: false,
        created: new Date()
    });

    log.info('ACME', 'ACME account provisioned for %s (%s)', acmeOptions.key, r.insertedId);

    return {
        key: accountKey,
        account
    };
};

const validateDomain = async domain => {
    // check domain name format
    const validation = Joi.string()
        .domain({ tlds: { allow: true } })
        .validate(domain);

    if (validation.error) {
        // invalid domain name, can not create certificate
        let err = new Error('${domain} is not a valid domain name');
        err.responseCode = 400;
        err.code = 'invalid_domain';
        throw err;
    }

    // check CAA support
    const caaDomains = config.acme.caaDomains.map(normalizeDomain).filter(d => d);

    // CAA support in node 15+
    if (typeof resolver.resolveCaa === 'function' && caaDomains.length) {
        let parts = domain.split('.');
        for (let i = 0; i < parts.length - 1; i++) {
            let subdomain = parts.slice(i).join('.');
            let caaRes;

            try {
                caaRes = await resolver.resolveCaa(subdomain);
            } catch (err) {
                // assume not found
            }

            if (caaRes && caaRes.length && !caaRes.some(r => config.acme.caaDomains.includes(normalizeDomain(r && r.issue)))) {
                let err = new Error(`LE not listed in the CAA record for ${subdomain} (${domain})`);
                err.responseCode = 403;
                err.code = 'caa_mismatch';
                throw err;
            } else if (caaRes && caaRes.length) {
                log.info('ACME', 'Found matching CAA record for %s (%s)', subdomain, domain);
                break;
            }
        }
    }

    return true;
};

const acquireCert = async (domain, acmeOptions, certificateData) => {
    const domainSafeLockKey = `d:lock:safe:${domain}`;
    const domainOpLockKey = `d:lock:op:${domain}`;

    if (await db.redis.exists(domainSafeLockKey)) {
        // nothing to do here, renewal blocked
        log.info('ACME', 'Renewal blocked by failsafe lock for %s', domain);

        // use default
        return certificateData;
    }

    try {
        // throws if can not validate domain
        await validateDomain(domain);
        log.info('ACME', 'Domain validation for %s passed', domain);
    } catch (err) {
        log.error('ACME', 'Failed to validate domain %s: %s', domain, err.message);
        return certificateData;
    }

    // Use locking to avoid race conditions, first try gets the lock, others wait until first is finished
    if (!getLock) {
        let lock = new Lock({
            redis: db.redis,
            namespace: 'acme'
        });
        getLock = util.promisify(lock.waitAcquireLock.bind(lock));
        releaseLock = util.promisify(lock.releaseLock.bind(lock));
    }

    let lock = await getLock(domainOpLockKey, 10 * 60 * 1000, 3 * 60 * 1000);
    try {
        // reload from db, maybe already renewed
        certificateData = await certHandler.getRecord({ _id: certificateData._id }, true);
        if (certificateData.expires > new Date(Date.now() + RENEW_AFTER_REMAINING)) {
            // no need to renew
            return certificateData;
        }

        let privateKey = certificateData.privateKey;
        if (!privateKey) {
            // generate new key
            log.info('ACME', 'Provision new private key for %s', domain);
            privateKey = await certHandler.resetPrivateKey({ _id: certificateData._id }, config.acme);
        }

        const jwkPrivateKey = pem2jwk(privateKey);
        const csr = await CSR.csr({
            jwk: jwkPrivateKey,
            domains: [domain],
            encoding: 'pem'
        });

        const acmeAccount = await getAcmeAccount(acmeOptions);
        if (!acmeAccount) {
            log.info('ACME', 'Skip certificate renwal for %s, acme account not found', domain);
            return false;
        }

        const jwkAccount = pem2jwk(acmeAccount.key);
        const certificateOptions = {
            account: acmeAccount.account,
            accountKey: jwkAccount,
            csr,
            domains: [domain],
            challenges: {
                'http-01': AcmeChallenge.create({
                    db: db.database
                })
            }
        };

        const aID = ((acmeAccount && acmeAccount.account && acmeAccount.account.key && acmeAccount.account.key.kid) || '').split('/acct/').pop();

        log.info('ACME', 'Generate ACME cert for %s (account=%s)', domain, aID);
        const cert = await acme.certificates.create(certificateOptions);
        if (!cert || !cert.cert) {
            log.error('ACME', 'Failed to generate certificate for %s', domain);
            return cert;
        }

        log.info('ACME', 'Received certificate from ACME for %s', domain);
        let now = new Date();
        const parsed = Certificate.fromPEM(cert.cert);

        let updates = {
            cert: cert.cert,
            ca: [].concat(cert.chain || []),
            validFrom: new Date(parsed.validFrom),
            expires: new Date(parsed.validTo),
            altNames: parsed.dnsNames,
            issuer: parsed.issuer.commonName,
            lastCheck: now,
            status: 'valid'
        };

        let updated = await certHandler.update({ _id: certificateData._id }, updates);
        if (!updated) {
            log.error('ACME', 'Failed to generate certificate for %s', domain);
            return cert;
        }

        log.info('ACME', 'Certificate successfully generated for %s (expires %s)', domain, parsed.validTo);
        return await certHandler.getRecord({ _id: certificateData._id }, true);
    } catch (err) {
        try {
            await db.redis.multi().set(domainSafeLockKey, 1).expire(domainSafeLockKey, BLOCK_RENEW_AFTER_ERROR_TTL).exec();
        } catch (err) {
            log.error('ACME', 'Redis call failed key=%s domains=%s error=%s', domainSafeLockKey, domain, err.message);
        }

        log.error('ACME', 'Failed to generate cert domains=%s error=%s', domain, err.message);
        if (certificateData && certificateData.cert) {
            // use existing certificate data if exists
            return certificateData;
        }

        throw err;
    } finally {
        try {
            await releaseLock(lock);
        } catch (err) {
            log.error('Lock', 'Failed to release lock for %s: %s', domainOpLockKey, err);
        }
    }
};

const getCertificate = async (domain, acmeOptions) => {
    if (!certHandler) {
        certHandler = new CertHandler({
            cipher: config.certs && config.certs.cipher,
            secret: config.certs && config.certs.secret,
            database: db.database,
            redis: db.redis
        });
    }

    await ensureAcme(acmeOptions);

    domain = normalizeDomain(domain);

    let certificateData = await certHandler.getRecord({ servername: domain }, true);
    if (!certificateData) {
        let err = new Error('Missing certificate info for ${domain}');
        err.responseCode = 404;
        err.code = 'missing_certificate';
        throw err;
    }

    if (certificateData.expires > new Date(Date.now() + 30 * 24 * 3600 * 1000)) {
        // no need to renew, use existing
        return certificateData;
    }

    if (certificateData.expires > Date.now()) {
        // can use the stored cert and renew in background
        // TODO: push to cert renewal job queue

        acquireCert(domain, acmeOptions, certificateData).catch(err => {
            log.error('ACME', 'Cert renewal error %s: %s', domain, err.message);
        });

        return certificateData;
    }

    return await acquireCert(domain, acmeOptions, certificateData);
};

module.exports = {
    getCertificate
};