// Minimal fake Azure Resource Manager so azurerm can `terraform plan` offline.
import { createServer } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";
const [cert, key, port, log] = process.argv.slice(2);
const base = `https://localhost:${port}`;
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  if (log) appendFileSync(log, `${req.method} ${req.url}\n`);
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url, base);
  if (url.pathname === "/metadata/endpoints") {
    return res.end(JSON.stringify({
      name: "AzureCloud",
      resourceManager: `${base}/`,
      authentication: { loginEndpoint: "https://login.microsoftonline.com/", audiences: [`${base}/`], tenant: "common", identityProvider: "AAD" },
      graph: `${base}/`, graphAudience: `${base}/`, microsoftGraphResourceId: `${base}/`,
      suffixes: { storage: "core.windows.net", keyVaultDns: "vault.azure.net", sqlServerHostname: "database.windows.net", acrLoginServer: "azurecr.io" },
      batch: `${base}/`, portal: `${base}/`, gallery: `${base}/`, media: `${base}/`, sqlManagement: `${base}/`,
    }));
  }
  if (/^\/subscriptions\/[^/]+\/providers\/?$/.test(url.pathname)) return res.end(JSON.stringify({ value: [] }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: "NotMocked", message: `${req.method} ${url.pathname}` } }));
}).listen(Number(port), "127.0.0.1");
