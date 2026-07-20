"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const config_1 = require("./config");
const app = (0, app_1.buildApp)();
app.listen(config_1.config.port, () => {
    console.log(`AfroPay anchor API listening on :${config_1.config.port}`);
    console.log(`  home domain:            ${config_1.config.homeDomain}`);
    console.log(`  network:                ${config_1.config.networkPassphrase}`);
    console.log(`  WEB_AUTH_ENDPOINT:      ${config_1.config.webAuthEndpoint}`);
    console.log(`  KYC_SERVER:             ${config_1.config.kycServer}`);
    console.log(`  DIRECT_PAYMENT_SERVER:  ${config_1.config.directPaymentServer}`);
});
//# sourceMappingURL=server.js.map