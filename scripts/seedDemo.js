
/**
 * Seeds FICTIONAL demo data on a LOCAL Hardhat chain only (chainId 31337).
 * All names, amounts and receipts below are invented.
 * Ledger entries do not represent real payments.
 *
 * Usage: npm run seed (after npm run deploy)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hre from "hardhat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENT = path.join(
  __dirname,
  "..",
  "frontend",
  "src",
  "contract",
  "deployment.json"
);

const Student = 0;
const Sponsorship = 1;

async function main() {
  const { ethers } = await hre.network.connect();

  const chainId = Number(
    (await ethers.provider.getNetwork()).chainId
  );

  if (chainId !== 31337) {
    throw new Error(
      `Refusing to seed: chainId ${chainId} is not the local Hardhat network (31337).`
    );
  }

  if (!fs.existsSync(DEPLOYMENT)) {
    throw new Error(
      "deployment.json not found. Run `npm run deploy` first."
    );
  }

  const dep = JSON.parse(
    fs.readFileSync(DEPLOYMENT, "utf8")
  );

  const code = await ethers.provider.getCode(dep.address);

  if (code === "0x") {
    throw new Error(
      "No contract at the address in deployment.json. Re-run `npm run deploy` on a running node."
    );
  }

  // Hardhat default accounts:
  // #0 admin | #1,#2 approvers | #3 organizer(Cultural)
  // #4 organizer(Tech) | #5 organizer(Sports) | #6+ contributors
  const [
    admin,
    approver1,
    approver2,
    orgCultural,
    orgTech,
    orgSports,
    c1,
    c2,
    c3,
    c4,
  ] = await ethers.getSigners();

  const fund = await ethers.getContractAt(
    "CollegeEventFund",
    dep.address,
    admin
  );

  if (await fund.eventExists(1)) {
    console.log(
      "Event 1 already exists - demo data appears to be seeded already. Redeploy to reseed."
    );
    return;
  }

  const send = async (promise) => (await promise).wait();

  const APPROVER_ROLE = await fund.APPROVER_ROLE();

  await send(fund.grantRole(APPROVER_ROLE, approver1.address));
  await send(fund.grantRole(APPROVER_ROLE, approver2.address));

  await send(
    fund.createEvent(
      1,
      "Annual Cultural Fest (DEMO)",
      "Fictional demo event",
      "Venue: Main Auditorium (fictional)",
      200000,
      250000,
      orgCultural.address
    )
  );

  await send(
    fund.createEvent(
      2,
      "Technical Symposium (DEMO)",
      "Fictional demo event",
      "Venue: CS Block (fictional)",
      120000,
      150000,
      orgTech.address
    )
  );

  await send(
    fund.createEvent(
      3,
      "Sports Day (DEMO)",
      "Fictional demo event",
      "Venue: College Ground (fictional)",
      60000,
      60000,
      orgSports.address
    )
  );

  const contrib = (org, id, who, label, amount, kind, ref) =>
    send(
      fund
        .connect(org)
        .recordContribution(
          id,
          who.address,
          label,
          amount,
          kind,
          ref
        )
    );

  const expense = (org, id, category, description, amount, receipt) =>
    send(
      fund
        .connect(org)
        .submitExpense(id, category, description, amount, receipt)
    );

  // Event 1 - Cultural Fest
  await contrib(orgCultural, 1, c1, "Batch 2024 students", 45000, Student, "DEMO-CF-001");
  await contrib(orgCultural, 1, c2, "Sponsor: Demo Café Co.", 120000, Sponsorship, "DEMO-CF-002");
  await contrib(orgCultural, 1, c3, "Alumni group", 25000, Student, "DEMO-CF-003");

  await expense(orgCultural, 1, "Stage & Sound", "Stage and sound system rental (fictional)", 80000, "DEMO-INV-CF-101");
  await expense(orgCultural, 1, "Decoration", "Decor and lighting (fictional)", 25000, "DEMO-INV-CF-102");
  await expense(orgCultural, 1, "Printing", "Poster printing (fictional)", 12000, "DEMO-INV-CF-103");
  await expense(orgCultural, 1, "Catering", "Volunteer refreshments (fictional)", 30000, "DEMO-INV-CF-104");

  // Event 2 - Tech Symposium
  await contrib(orgTech, 2, c2, "Sponsor: Demo Tech Pvt Ltd", 50000, Sponsorship, "DEMO-TS-001");
  await contrib(orgTech, 2, c4, "CS dept students", 60000, Student, "DEMO-TS-002");

  await expense(orgTech, 2, "Honorarium", "Guest speaker honorarium (fictional)", 40000, "DEMO-INV-TS-201");
  await expense(orgTech, 2, "Workshop", "Workshop kits (fictional)", 20000, "DEMO-INV-TS-202");
  await expense(orgTech, 2, "Certificates", "Certificates and printing (fictional)", 8000, "DEMO-INV-TS-203");

  // Event 3 - Sports Day
  await contrib(orgSports, 3, c1, "Sports committee", 58000, Student, "DEMO-SD-001");

  await expense(orgSports, 3, "Equipment", "Sports equipment (fictional)", 30000, "DEMO-INV-SD-301");
  await expense(orgSports, 3, "Refreshments", "Players refreshments (fictional)", 25000, "DEMO-INV-SD-302");

  // Reviews: approvers are separate from expense submitters.
  await send(fund.connect(approver1).approveExpense(1));
  await send(fund.connect(approver1).approveExpense(2));
  await send(
    fund
      .connect(approver2)
      .rejectExpense(
        3,
        "Duplicate of an earlier printing invoice (fictional reason)"
      )
  );

  await send(fund.connect(approver2).approveExpense(5));
  await send(fund.connect(approver2).approveExpense(6));
  await send(fund.connect(approver1).approveExpense(8));
  await send(fund.connect(approver1).approveExpense(9));

  console.log("Seeded 3 FICTIONAL events with contributions and expenses.");
  console.log("Roles (Hardhat default accounts):");
  console.log(`  Admin      #0 ${admin.address}`);
  console.log(`  Approver 1 #1 ${approver1.address}`);
  console.log(`  Approver 2 #2 ${approver2.address}`);
  console.log(`  Organizer  #3 ${orgCultural.address} (Event 1)`);
  console.log(`  Organizer  #4 ${orgTech.address} (Event 2)`);
  console.log(`  Organizer  #5 ${orgSports.address} (Event 3)`);
  console.log("  Student/public viewer: any other account, e.g. #6+");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
