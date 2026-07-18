import { buildApp } from "./app";
import { config } from "./config";

const app = buildApp();

app.listen(config.port, () => {
  console.log(`AfroPay anchor API listening on :${config.port}`);
  console.log(`  home domain:            ${config.homeDomain}`);
  console.log(`  network:                ${config.networkPassphrase}`);
  console.log(`  WEB_AUTH_ENDPOINT:      ${config.webAuthEndpoint}`);
  console.log(`  KYC_SERVER:             ${config.kycServer}`);
  console.log(`  DIRECT_PAYMENT_SERVER:  ${config.directPaymentServer}`);
});
