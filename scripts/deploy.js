
/**
 * Deploys CollegeEventFund and writes:
 * frontend/src/contract/deployment.json
 *
 * Usage:
 * Terminal 1: npx hardhat node
 * Terminal 2: npm run deploy
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hre from "hardhat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT = path.join(
  __dirname,
  "..",
  "frontend",
  "src",
  "contract",
  "deployment.json"
);

async function main() {
  // Connect to the configured Hardhat network.
  const connection = await hre.network.connect();
  const { ethers, networkHelpers } = connection;

  const [admin] = await ethers.getSigners();

  const chainId = Number(
    (await ethers.provider.getNetwork()).chainId
  );

  console.log(`Network : ${hre.globalOptions.network ?? "default"} (chainId ${chainId})`);
  console.log(`Admin   : ${admin.address} (DEFAULT_ADMIN_ROLE)`);

  const Fund = await ethers.getContractFactory("CollegeEventFund");
  const fund = await Fund.deploy(admin.address);

  await fund.waitForDeployment();

  const address = await fund.getAddress();
  const receipt = await fund.deploymentTransaction().wait();

  const artifact = await hre.artifacts.readArtifact(
    "CollegeEventFund"
  );

  const deployment = {
    contractName: "CollegeEventFund",
    network: hre.globalOptions.network ?? "default",
    chainId,
    address,
    admin: admin.address,
    deployTxHash: receipt.hash,
    deployBlock: receipt.blockNumber,
    abi: artifact.abi,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(deployment, null, 2),
    "utf8"
  );

  console.log(`Contract: ${address}`);
  console.log(`Block   : ${receipt.blockNumber}`);
  console.log(`Wrote   : ${path.relative(process.cwd(), OUTPUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
