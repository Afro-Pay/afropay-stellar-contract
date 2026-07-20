"use strict";
/**
 * In-memory data store for SEP-12 customers and SEP-31 transactions.
 * Production deployments must replace this with persistent storage; the
 * interfaces below define the data shapes the SEP endpoints rely on.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.passes = exports.creatorContents = exports.tierContentKeys = exports.tiers = exports.transactions = exports.customers = void 0;
exports.findCustomer = findCustomer;
exports.findTierById = findTierById;
exports.findTierContentKeyByTierId = findTierContentKeyByTierId;
exports.findAllTierContentKeysByTierId = findAllTierContentKeysByTierId;
exports.findCreatorContentsByTierId = findCreatorContentsByTierId;
exports.findActivePass = findActivePass;
exports.customers = new Map();
exports.transactions = new Map();
function findCustomer(query) {
    if (query.id)
        return exports.customers.get(query.id);
    for (const customer of exports.customers.values()) {
        if (customer.account === query.account &&
            (customer.memo ?? undefined) === (query.memo ?? undefined)) {
            return customer;
        }
    }
    return undefined;
}
exports.tiers = new Map();
exports.tierContentKeys = new Map();
exports.creatorContents = new Map();
exports.passes = new Map();
function findTierById(id) {
    return exports.tiers.get(id);
}
function findTierContentKeyByTierId(tierId) {
    for (const key of exports.tierContentKeys.values()) {
        if (key.tierId === tierId) {
            return key;
        }
    }
    return undefined;
}
function findAllTierContentKeysByTierId(tierId) {
    const keys = [];
    for (const key of exports.tierContentKeys.values()) {
        if (key.tierId === tierId) {
            keys.push(key);
        }
    }
    return keys;
}
function findCreatorContentsByTierId(tierId) {
    const contents = [];
    for (const content of exports.creatorContents.values()) {
        if (content.tierId === tierId) {
            contents.push(content);
        }
    }
    return contents;
}
function findActivePass(fanAccount, tierId) {
    for (const pass of exports.passes.values()) {
        if (pass.fanAccount === fanAccount && pass.tierId === tierId && pass.active) {
            return pass;
        }
    }
    return undefined;
}
//# sourceMappingURL=store.js.map