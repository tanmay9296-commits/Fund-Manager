import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
const Student = 0, Sponsorship = 1;
const Pending = 0, Approved = 1, Rejected = 2;
const Active = 0, Closed = 1;

describe("CollegeEventFund", function () {
  async function deployFixture() {
    const [admin, organizer, organizer2, approver, student, contributor] = await ethers.getSigners();
    const Fund = await ethers.getContractFactory("CollegeEventFund");
    const fund = await Fund.deploy(admin.address);
    await fund.waitForDeployment();

    const APPROVER_ROLE = await fund.APPROVER_ROLE();
    await fund.connect(admin).grantRole(APPROVER_ROLE, approver.address);

    // Event 1: budget 100,000 / target 150,000 ; Event 2: budget 50,000 / target 80,000
    await fund.createEvent(1, "Cultural Fest", "Demo", "", 100000, 150000, organizer.address);
    await fund.createEvent(2, "Tech Symposium", "Demo", "", 50000, 80000, organizer2.address);
    return { fund, admin, organizer, organizer2, approver, student, contributor, APPROVER_ROLE };
  }

  // helper: record a contribution
  const contribute = (fund, signer, eventId, who, amount, ref, kind = Student) =>
    fund.connect(signer).recordContribution(eventId, who, "label", amount, kind, ref);

  describe("Event management", function () {
    it("[T1] administrator successfully creates an event", async function () {
      const { fund, admin, organizer } = await deployFixture();
      await expect(fund.connect(admin).createEvent(10, "Sports Day", "d", "venue: ground", 30000, 40000, organizer.address))
        .to.emit(fund, "EventCreated")
        .withArgs(10, "Sports Day", 30000, 40000, organizer.address, admin.address);
      const ev = await fund.getFundEvent(10);
      expect(ev.name).to.equal("Sports Day");
      expect(ev.budget).to.equal(30000);
      expect(ev.fundraisingTarget).to.equal(40000);
      expect(ev.organizer).to.equal(organizer.address);
      expect(ev.status).to.equal(Active);
      expect(await fund.getEventCount()).to.equal(3);
      expect(await fund.hasRole(await fund.ORGANIZER_ROLE(), organizer.address)).to.equal(true);
    });

    it("[T2] unauthorized users cannot create events", async function () {
      const { fund, student, organizer, approver } = await deployFixture();
      for (const s of [student, organizer, approver]) {
        await expect(fund.connect(s).createEvent(99, "X", "d", "", 1, 1, organizer.address))
          .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount");
      }
      expect(await fund.eventExists(99)).to.equal(false);
    });

    it("[T3] duplicate event IDs are rejected", async function () {
      const { fund, organizer } = await deployFixture();
      await expect(fund.createEvent(1, "Dup", "d", "", 1, 1, organizer.address))
        .to.be.revertedWithCustomError(fund, "EventAlreadyExists").withArgs(1);
    });

    it("rejects invalid event inputs (id 0, zero organizer, empty/oversized name)", async function () {
      const { fund, organizer } = await deployFixture();
      await expect(fund.createEvent(0, "A", "d", "", 1, 1, organizer.address)).to.be.revertedWithCustomError(fund, "InvalidEventId");
      await expect(fund.createEvent(50, "A", "d", "", 1, 1, ethers.ZeroAddress)).to.be.revertedWithCustomError(fund, "InvalidAddress");
      await expect(fund.createEvent(50, "", "d", "", 1, 1, organizer.address)).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(fund.createEvent(50, "a".repeat(101), "d", "", 1, 1, organizer.address)).to.be.revertedWithCustomError(fund, "InvalidText");
    });
  });

  describe("Contributions", function () {
    it("[T4] authorized organizer can record contributions and totals update", async function () {
      const { fund, organizer, contributor } = await deployFixture();
      await expect(contribute(fund, organizer, 1, contributor.address, 5000, "RCPT-001"))
        .to.emit(fund, "ContributionRecorded")
        .withArgs(1, 1, contributor.address, 5000, Student, "RCPT-001", organizer.address);
      await contribute(fund, organizer, 1, contributor.address, 20000, "SPON-001", Sponsorship);
      const s = await fund.getSummary(1);
      expect(s.totalContributions).to.equal(25000);
      expect(s.remainingBalance).to.equal(25000);
      expect(await fund.getContributionCount()).to.equal(2);
      expect((await fund.getContribution(2)).kind).to.equal(Sponsorship);
      expect(await fund.getEventContributionIds(1)).to.deep.equal([1n, 2n]);
    });

    it("[T5] invalid or unauthorized contributions are rejected", async function () {
      const { fund, admin, organizer, organizer2, approver, student, contributor } = await deployFixture();
      // not an organizer / wrong organizer (organizer2 owns event 2, not event 1) / admin and approver have no ledger-write rights
      for (const s of [student, organizer2, admin, approver]) {
        await expect(contribute(fund, s, 1, contributor.address, 100, "X-" + s.address))
          .to.be.revertedWithCustomError(fund, "NotEventOrganizer");
      }
      await expect(contribute(fund, organizer, 1, contributor.address, 0, "R0")).to.be.revertedWithCustomError(fund, "InvalidAmount");
      await expect(contribute(fund, organizer, 1, ethers.ZeroAddress, 5, "R1")).to.be.revertedWithCustomError(fund, "InvalidAddress");
      await expect(contribute(fund, organizer, 1, contributor.address, 5, "")).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(contribute(fund, organizer, 777, contributor.address, 5, "R2")).to.be.revertedWithCustomError(fund, "EventNotFound");
      // duplicate reference (even across events)
      await contribute(fund, organizer, 1, contributor.address, 5, "DUP");
      await expect(contribute(fund, organizer, 1, contributor.address, 5, "DUP"))
        .to.be.revertedWithCustomError(fund, "DuplicateReference").withArgs("DUP");
      await expect(contribute(fund, organizer2, 2, contributor.address, 5, "DUP"))
        .to.be.revertedWithCustomError(fund, "DuplicateReference");
    });
  });

  describe("Expenses", function () {
    it("[T6] organizers can submit expense requests (status Pending)", async function () {
      const { fund, organizer } = await deployFixture();
      await expect(fund.connect(organizer).submitExpense(1, "Stage", "Stage rental", 8000, "INV-1"))
        .to.emit(fund, "ExpenseSubmitted").withArgs(1, 1, organizer.address, "Stage", 8000, "INV-1");
      const ex = await fund.getExpense(1);
      expect(ex.status).to.equal(Pending);
      expect(ex.submitter).to.equal(organizer.address);
      expect(ex.amount).to.equal(8000);
      expect((await fund.getSummary(1)).totalPending).to.equal(8000);
      expect(await fund.getEventExpenseIds(1)).to.deep.equal([1n]);
    });

    it("rejects invalid or unauthorized expense submissions", async function () {
      const { fund, organizer, organizer2, student } = await deployFixture();
      await expect(fund.connect(student).submitExpense(1, "A", "b", 1, "r")).to.be.revertedWithCustomError(fund, "NotEventOrganizer");
      await expect(fund.connect(organizer2).submitExpense(1, "A", "b", 1, "r")).to.be.revertedWithCustomError(fund, "NotEventOrganizer");
      await expect(fund.connect(organizer).submitExpense(1, "A", "b", 0, "r")).to.be.revertedWithCustomError(fund, "InvalidAmount");
      await expect(fund.connect(organizer).submitExpense(1, "", "b", 1, "r")).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(fund.connect(organizer).submitExpense(1, "A", "", 1, "r")).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(fund.connect(organizer).submitExpense(1, "A", "b", 1, "")).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(fund.connect(organizer).submitExpense(555, "A", "b", 1, "r")).to.be.revertedWithCustomError(fund, "EventNotFound");
    });

    it("[T7] approver can approve a valid expense", async function () {
      const { fund, organizer, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 20000, "C1");
      await fund.connect(organizer).submitExpense(1, "Stage", "Stage", 8000, "INV-1");
      await expect(fund.connect(approver).approveExpense(1))
        .to.emit(fund, "ExpenseApproved").withArgs(1, 1, approver.address, 8000);
      const ex = await fund.getExpense(1);
      expect(ex.status).to.equal(Approved);
      expect(ex.reviewer).to.equal(approver.address);
      expect(ex.reviewedAt).to.be.gt(0);
    });

    it("[T8] approver can reject an expense with a reason; empty reason is refused", async function () {
      const { fund, organizer, approver } = await deployFixture();
      await fund.connect(organizer).submitExpense(1, "Food", "Snacks", 3000, "INV-2");
      await expect(fund.connect(approver).rejectExpense(1, "")).to.be.revertedWithCustomError(fund, "InvalidText");
      await expect(fund.connect(approver).rejectExpense(1, "Receipt unreadable"))
        .to.emit(fund, "ExpenseRejected").withArgs(1, 1, approver.address, 3000, "Receipt unreadable");
      const ex = await fund.getExpense(1);
      expect(ex.status).to.equal(Rejected);
      expect(ex.reviewNote).to.equal("Receipt unreadable");
    });

    it("[T9] unauthorized users cannot approve or reject expenses", async function () {
      const { fund, admin, organizer, student } = await deployFixture();
      await fund.connect(organizer).submitExpense(1, "A", "b", 100, "r");
      for (const s of [student, organizer, admin]) {
        await expect(fund.connect(s).approveExpense(1)).to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount");
        await expect(fund.connect(s).rejectExpense(1, "no")).to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount");
      }
      expect((await fund.getExpense(1)).status).to.equal(Pending);
    });

    it("[T10] an expense cannot be approved or rejected twice (or flipped)", async function () {
      const { fund, organizer, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 20000, "C1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 1000, "r1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 1000, "r2");
      await fund.connect(approver).approveExpense(1);
      await expect(fund.connect(approver).approveExpense(1)).to.be.revertedWithCustomError(fund, "ExpenseNotPending").withArgs(1);
      await expect(fund.connect(approver).rejectExpense(1, "late")).to.be.revertedWithCustomError(fund, "ExpenseNotPending");
      await fund.connect(approver).rejectExpense(2, "no");
      await expect(fund.connect(approver).approveExpense(2)).to.be.revertedWithCustomError(fund, "ExpenseNotPending");
      expect((await fund.getSummary(1)).totalApproved).to.equal(1000);
    });

    it("[T11] pending and rejected expenses are excluded from approved expenditure", async function () {
      const { fund, organizer, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 50000, "C1");
      await fund.connect(organizer).submitExpense(1, "A", "approved one", 4000, "r1"); // 1
      await fund.connect(organizer).submitExpense(1, "A", "rejected one", 6000, "r2"); // 2
      await fund.connect(organizer).submitExpense(1, "A", "pending one", 7000, "r3");  // 3
      await fund.connect(approver).approveExpense(1);
      await fund.connect(approver).rejectExpense(2, "Not eligible");
      const s = await fund.getSummary(1);
      expect(s.totalApproved).to.equal(4000);
      expect(s.totalRejected).to.equal(6000);
      expect(s.totalPending).to.equal(7000);
      expect(s.remainingBalance).to.equal(46000); // pending/rejected do not reduce balance
    });

    it("[T12] remaining balance updates correctly after approvals", async function () {
      const { fund, organizer, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 30000, "C1");
      await contribute(fund, organizer, 1, contributor.address, 10000, "C2", Sponsorship);
      expect((await fund.getSummary(1)).remainingBalance).to.equal(40000);
      await fund.connect(organizer).submitExpense(1, "A", "b", 12000, "r1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 8000, "r2");
      await fund.connect(approver).approveExpense(1);
      expect((await fund.getSummary(1)).remainingBalance).to.equal(28000);
      await fund.connect(approver).approveExpense(2);
      const s = await fund.getSummary(1);
      expect(s.remainingBalance).to.equal(20000);
      expect(s.budgetUtilizationBps).to.equal(2000);  // 20,000 / 100,000 = 20.00%
      expect(s.fundingProgressBps).to.equal(2666);    // 40,000 / 150,000 = 26.66% (floor)
    });

    it("[T13] approval is blocked when it would exceed budget or available balance", async function () {
      const { fund, organizer, organizer2, approver, contributor } = await deployFixture();
      // Available-balance limit: only 5,000 recorded, request 6,000 (budget 100,000 is fine)
      await contribute(fund, organizer, 1, contributor.address, 5000, "C1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 6000, "r1");
      await expect(fund.connect(approver).approveExpense(1))
        .to.be.revertedWithCustomError(fund, "ExceedsAvailableBalance").withArgs(6000, 5000);

      // Budget limit: event 2 budget 50,000; contributions 70,000; approve 30,000 then 25,000 (cumulative 55,000)
      await contribute(fund, organizer2, 2, contributor.address, 70000, "C2");
      await fund.connect(organizer2).submitExpense(2, "A", "b", 30000, "r2"); // id 2
      await fund.connect(organizer2).submitExpense(2, "A", "b", 25000, "r3"); // id 3
      await fund.connect(approver).approveExpense(2);
      await expect(fund.connect(approver).approveExpense(3))
        .to.be.revertedWithCustomError(fund, "ExceedsBudget").withArgs(55000, 50000);

      // Two individually-valid requests cannot jointly bypass the limit (re-check at approval time)
      await contribute(fund, organizer, 1, contributor.address, 4000, "C3"); // event1 total 9,000
      await fund.connect(organizer).submitExpense(1, "A", "b", 5000, "r4"); // id 4
      await fund.connect(approver).rejectExpense(1, "too large"); // clear id 1
      await fund.connect(approver).approveExpense(4);             // 5,000 <= 9,000 ok
      await fund.connect(organizer).submitExpense(1, "A", "b", 5000, "r5"); // id 5
      await expect(fund.connect(approver).approveExpense(5))
        .to.be.revertedWithCustomError(fund, "ExceedsAvailableBalance").withArgs(10000, 9000);
    });

    it("approver cannot review an expense they submitted themselves (separation of duties)", async function () {
      const { fund, admin, approver, APPROVER_ROLE } = await deployFixture();
      // make the approver also an organizer of a new event
      await fund.createEvent(7, "Self", "d", "", 1000, 1000, approver.address);
      await fund.connect(approver).recordContribution(7, approver.address, "", 1000, Student, "SELF-1");
      await fund.connect(approver).submitExpense(7, "A", "b", 500, "r");
      await expect(fund.connect(approver).approveExpense(1)).to.be.revertedWithCustomError(fund, "SelfApprovalNotAllowed");
      await expect(fund.connect(approver).rejectExpense(1, "x")).to.be.revertedWithCustomError(fund, "SelfApprovalNotAllowed");
    });
  });

  describe("Multi-event, closing, zero cases, atomicity", function () {
    it("[T14] financial totals remain correct and independent across multiple events", async function () {
      const { fund, organizer, organizer2, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 40000, "A1");
      await contribute(fund, organizer2, 2, contributor.address, 15000, "B1", Sponsorship);
      await fund.connect(organizer).submitExpense(1, "A", "b", 10000, "ra");  // id 1
      await fund.connect(organizer2).submitExpense(2, "A", "b", 5000, "rb");  // id 2
      await fund.connect(organizer2).submitExpense(2, "A", "b", 2000, "rc");  // id 3
      await fund.connect(approver).approveExpense(1);
      await fund.connect(approver).approveExpense(2);
      const s1 = await fund.getSummary(1);
      const s2 = await fund.getSummary(2);
      expect([s1.totalContributions, s1.totalApproved, s1.totalPending, s1.remainingBalance]).to.deep.equal([40000n, 10000n, 0n, 30000n]);
      expect([s2.totalContributions, s2.totalApproved, s2.totalPending, s2.remainingBalance]).to.deep.equal([15000n, 5000n, 2000n, 10000n]);
      // cross-check against raw ledger arrays
      let sumC = 0n;
      for (const id of await fund.getEventIds()) sumC += (await fund.getSummary(id)).totalContributions;
      expect(sumC).to.equal(55000n);
    });

    it("[T15] closed events reject contributions, expenses and reviews; closing needs no pending expenses", async function () {
      const { fund, admin, organizer, approver, student, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 20000, "C1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 1000, "r1");

      await expect(fund.connect(student).closeEvent(1)).to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount");
      await expect(fund.connect(admin).closeEvent(1)).to.be.revertedWithCustomError(fund, "PendingExpensesExist").withArgs(1, 1000);

      await fund.connect(approver).approveExpense(1);
      await expect(fund.connect(admin).closeEvent(1)).to.emit(fund, "EventClosed").withArgs(1, admin.address);
      expect((await fund.getFundEvent(1)).status).to.equal(Closed);

      await expect(contribute(fund, organizer, 1, contributor.address, 5, "C2")).to.be.revertedWithCustomError(fund, "EventNotActive");
      await expect(fund.connect(organizer).submitExpense(1, "A", "b", 5, "r")).to.be.revertedWithCustomError(fund, "EventNotActive");
      await expect(fund.connect(admin).closeEvent(1)).to.be.revertedWithCustomError(fund, "EventNotActive");
      await expect(fund.connect(admin).setEventOrganizer(1, student.address)).to.be.revertedWithCustomError(fund, "EventNotActive");
      // other events are unaffected
      await expect(fund.connect(admin).closeEvent(2)).to.emit(fund, "EventClosed");
    });

    it("[T16] zero budget / zero target do not cause division errors", async function () {
      const { fund, admin, organizer, approver, contributor } = await deployFixture();
      await fund.connect(admin).createEvent(20, "Zero", "d", "", 0, 0, organizer.address);
      let s = await fund.getSummary(20);
      expect(s.budgetUtilizationBps).to.equal(0);
      expect(s.fundingProgressBps).to.equal(0);
      await contribute(fund, organizer, 20, contributor.address, 1000, "Z1");
      s = await fund.getSummary(20);
      expect(s.fundingProgressBps).to.equal(0);
      expect(s.remainingBalance).to.equal(1000);
      // zero budget means nothing can be approved
      await fund.connect(organizer).submitExpense(20, "A", "b", 1, "zr");
      await expect(fund.connect(approver).approveExpense(1)).to.be.revertedWithCustomError(fund, "ExceedsBudget").withArgs(1, 0);
    });

    it("[T17] important smart-contract events are emitted (incl. role grant and organizer change)", async function () {
      const { fund, admin, organizer, organizer2, student, APPROVER_ROLE } = await deployFixture();
      await expect(fund.connect(admin).grantRole(APPROVER_ROLE, student.address)).to.emit(fund, "RoleGranted");
      await expect(fund.connect(admin).setEventOrganizer(1, organizer2.address))
        .to.emit(fund, "OrganizerChanged").withArgs(1, organizer.address, organizer2.address);
      await expect(fund.connect(organizer).submitExpense(1, "A", "b", 1, "r")).to.be.revertedWithCustomError(fund, "NotEventOrganizer");
      await expect(fund.connect(admin).revokeRole(APPROVER_ROLE, student.address)).to.emit(fund, "RoleRevoked");
    });

    it("[T18] reverted transactions leave financial state unchanged", async function () {
      const { fund, organizer, approver, contributor } = await deployFixture();
      await contribute(fund, organizer, 1, contributor.address, 5000, "C1");
      await fund.connect(organizer).submitExpense(1, "A", "b", 9000, "r1");
      const before = await fund.getSummary(1);
      const cBefore = await fund.getContributionCount();
      const eBefore = await fund.getExpenseCount();

      await expect(
  fund.connect(approver).approveExpense(1)
).to.revert(ethers); // exceeds balance

await expect(
  contribute(fund, organizer, 1, contributor.address, 5000, "C1")
).to.revert(ethers); // duplicate ref

await expect(
  fund.connect(organizer).submitExpense(1, "A", "b", 0, "r")
).to.revert(ethers); // invalid amount

await expect(
  fund.connect(approver).rejectExpense(1, "")
).to.revert(ethers); // empty reason

      const after = await fund.getSummary(1);
      expect(after.totalContributions).to.equal(before.totalContributions);
      expect(after.totalApproved).to.equal(before.totalApproved);
      expect(after.totalPending).to.equal(before.totalPending);
      expect(after.totalRejected).to.equal(before.totalRejected);
      expect(await fund.getContributionCount()).to.equal(cBefore);
      expect(await fund.getExpenseCount()).to.equal(eBefore);
      expect((await fund.getExpense(1)).status).to.equal(Pending);
      expect(await fund.isReferenceUsed("C1")).to.equal(true);
    });

    it("view functions are public and lookups of unknown ids revert cleanly", async function () {
      const { fund, student } = await deployFixture();
      expect((await fund.connect(student).getFundEvent(1)).name).to.equal("Cultural Fest");
      await expect(fund.getFundEvent(404)).to.be.revertedWithCustomError(fund, "EventNotFound");
      await expect(fund.getExpense(1)).to.be.revertedWithCustomError(fund, "ExpenseNotFound");
      await expect(fund.getContribution(0)).to.be.revertedWithCustomError(fund, "ContributionNotFound");
    });
  });
});
