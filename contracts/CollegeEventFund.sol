// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title CollegeEventFund
 * @notice EDUCATIONAL DEMO. A tamper-evident *ledger* of college event finances.
 *
 * IMPORTANT - what this contract is NOT:
 *  - It does NOT hold, receive, or transfer ETH, tokens, or real money.
 *  - A recorded contribution is a ledger entry made by an authorised organizer.
 *    It does NOT prove that any real-world payment occurred.
 *  - An approved expense is a ledger entry. It does NOT pay anyone.
 *
 * Currency convention: every amount is an integer number of INR rupees
 * (1 unit = Rs 1). No decimals, no floating point, no ETH/INR conversion.
 *
 * Roles:
 *  - DEFAULT_ADMIN_ROLE : college administrator (creates/closes events, manages roles)
 *  - ORGANIZER_ROLE     : display/role marker; actual authority is per-event (event.organizer)
 *  - APPROVER_ROLE      : may approve/reject expenses
 *
 * Approval policy (re-checked at approval time, on cumulative approved totals):
 *    totalApproved + amount <= event.budget
 *    totalApproved + amount <= totalContributions   (available recorded balance)
 * Pending and rejected expenses never count as spent.
 *
 * Closing policy: an event cannot be closed while it has pending expenses.
 * A closed event rejects new contributions, expense submissions and reviews.
 */
contract CollegeEventFund is AccessControl {
    // ---------------------------------------------------------------- roles
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");

    // ---------------------------------------------------------------- types
    enum EventStatus { Active, Closed }
    enum ContributionType { Student, Sponsorship }
    enum ExpenseStatus { Pending, Approved, Rejected }

    struct FundEvent {
        uint256 id;
        string name;
        string description;
        string metadata;            // optional free-form (e.g. venue/date). Public!
        uint256 budget;             // INR
        uint256 fundraisingTarget;  // INR
        address organizer;
        EventStatus status;
        uint64 createdAt;
        uint64 closedAt;
        uint256 totalContributions;
        uint256 totalApproved;
        uint256 totalPending;
        uint256 totalRejected;
    }

    struct Contribution {
        uint256 id;
        uint256 eventId;
        address contributor;        // pseudonymous wallet of the contributor
        string label;               // optional pseudonymous label (avoid real names)
        uint256 amount;             // INR
        ContributionType kind;
        string refId;           // unique receipt / reference id
        address recordedBy;
        uint64 timestamp;
    }

    struct Expense {
        uint256 id;
        uint256 eventId;
        string category;
        string description;
        uint256 amount;             // INR
        address submitter;
        string receiptRef;          // e.g. an IPFS CID or invoice number
        uint64 submittedAt;
        ExpenseStatus status;
        address reviewer;
        uint64 reviewedAt;
        string reviewNote;          // rejection reason (required on reject)
    }

    struct Summary {
        uint256 totalContributions;
        uint256 totalApproved;
        uint256 totalPending;
        uint256 totalRejected;
        uint256 remainingBalance;        // contributions - approved
        uint256 budgetUtilizationBps;    // approved / budget, basis points (10000 = 100%)
        uint256 fundingProgressBps;      // contributions / target, basis points (may exceed 10000)
    }

    // ---------------------------------------------------------------- limits
    uint256 public constant MAX_NAME = 100;
    uint256 public constant MAX_TEXT = 500;
    uint256 public constant MAX_SHORT = 100;

    // ---------------------------------------------------------------- storage
    mapping(uint256 => FundEvent) private _events;
    mapping(uint256 => bool) private _eventExists;
    uint256[] private _eventIds;

    Contribution[] private _contributions; // id = index + 1
    Expense[] private _expenses;           // id = index + 1

    mapping(uint256 => uint256[]) private _eventContributionIds;
    mapping(uint256 => uint256[]) private _eventExpenseIds;
    mapping(bytes32 => bool) private _referenceUsed;

    // ---------------------------------------------------------------- events
    event EventCreated(
        uint256 indexed eventId, string name, uint256 budget, uint256 fundraisingTarget,
        address indexed organizer, address createdBy
    );
    event EventClosed(uint256 indexed eventId, address indexed closedBy);
    event OrganizerChanged(uint256 indexed eventId, address indexed oldOrganizer, address indexed newOrganizer);
    event ContributionRecorded(
        uint256 indexed contributionId, uint256 indexed eventId, address indexed contributor,
        uint256 amount, ContributionType kind, string refId, address recordedBy
    );
    event ExpenseSubmitted(
        uint256 indexed expenseId, uint256 indexed eventId, address indexed submitter,
        string category, uint256 amount, string receiptRef
    );
    event ExpenseApproved(uint256 indexed expenseId, uint256 indexed eventId, address indexed approver, uint256 amount);
    event ExpenseRejected(
        uint256 indexed expenseId, uint256 indexed eventId, address indexed approver, uint256 amount, string reason
    );

    // ---------------------------------------------------------------- errors
    error EventAlreadyExists(uint256 eventId);
    error EventNotFound(uint256 eventId);
    error EventNotActive(uint256 eventId);
    error ExpenseNotFound(uint256 expenseId);
    error ContributionNotFound(uint256 contributionId);
    error InvalidEventId();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidText(string field);
    error NotEventOrganizer(uint256 eventId, address caller);
    error DuplicateReference(string refId);
    error ExpenseNotPending(uint256 expenseId);
    error SelfApprovalNotAllowed();
    error ExceedsBudget(uint256 requestedTotal, uint256 budget);
    error ExceedsAvailableBalance(uint256 requestedTotal, uint256 available);
    error PendingExpensesExist(uint256 eventId, uint256 pendingAmount);

    // ---------------------------------------------------------------- setup
    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- modifiers
    modifier eventMustExist(uint256 eventId) {
        if (!_eventExists[eventId]) revert EventNotFound(eventId);
        _;
    }

    modifier eventMustBeActive(uint256 eventId) {
        if (!_eventExists[eventId]) revert EventNotFound(eventId);
        if (_events[eventId].status != EventStatus.Active) revert EventNotActive(eventId);
        _;
    }

    modifier onlyEventOrganizer(uint256 eventId) {
        if (_events[eventId].organizer != msg.sender) revert NotEventOrganizer(eventId, msg.sender);
        _;
    }

    // ---------------------------------------------------------------- event management
    /// @notice Admin creates an event. The caller chooses a unique, non-zero eventId.
    function createEvent(
        uint256 eventId,
        string calldata name,
        string calldata description,
        string calldata metadata,
        uint256 budget,
        uint256 fundraisingTarget,
        address organizer
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (eventId == 0) revert InvalidEventId();
        if (_eventExists[eventId]) revert EventAlreadyExists(eventId);
        if (organizer == address(0)) revert InvalidAddress();
        _requireText(name, 1, MAX_NAME, "name");
        _requireText(description, 0, MAX_TEXT, "description");
        _requireText(metadata, 0, MAX_TEXT, "metadata");

        FundEvent storage ev = _events[eventId];
        ev.id = eventId;
        ev.name = name;
        ev.description = description;
        ev.metadata = metadata;
        ev.budget = budget;
        ev.fundraisingTarget = fundraisingTarget;
        ev.organizer = organizer;
        ev.status = EventStatus.Active;
        ev.createdAt = uint64(block.timestamp);

        _eventExists[eventId] = true;
        _eventIds.push(eventId);

        if (!hasRole(ORGANIZER_ROLE, organizer)) _grantRole(ORGANIZER_ROLE, organizer);

        emit EventCreated(eventId, name, budget, fundraisingTarget, organizer, msg.sender);
    }

    /// @notice Admin reassigns the organizer of an active event.
    function setEventOrganizer(uint256 eventId, address newOrganizer)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        eventMustBeActive(eventId)
    {
        if (newOrganizer == address(0)) revert InvalidAddress();
        address old = _events[eventId].organizer;
        _events[eventId].organizer = newOrganizer;
        if (!hasRole(ORGANIZER_ROLE, newOrganizer)) _grantRole(ORGANIZER_ROLE, newOrganizer);
        emit OrganizerChanged(eventId, old, newOrganizer);
    }

    /// @notice Admin closes an event. Not allowed while expenses are pending.
    function closeEvent(uint256 eventId) external onlyRole(DEFAULT_ADMIN_ROLE) eventMustBeActive(eventId) {
        FundEvent storage ev = _events[eventId];
        if (ev.totalPending != 0) revert PendingExpensesExist(eventId, ev.totalPending);
        ev.status = EventStatus.Closed;
        ev.closedAt = uint64(block.timestamp);
        emit EventClosed(eventId, msg.sender);
    }

    // ---------------------------------------------------------------- contributions (ledger entries)
    /// @notice Event organizer records a contribution/sponsorship LEDGER ENTRY (no funds move).
    function recordContribution(
        uint256 eventId,
        address contributor,
        string calldata label,
        uint256 amount,
        ContributionType kind,
        string calldata refId
    ) external eventMustBeActive(eventId) onlyEventOrganizer(eventId) returns (uint256 contributionId) {
        if (amount == 0) revert InvalidAmount();
        if (contributor == address(0)) revert InvalidAddress();
        _requireText(label, 0, MAX_SHORT, "label");
        _requireText(refId, 1, MAX_SHORT, "refId");

        bytes32 refHash = keccak256(bytes(refId));
        if (_referenceUsed[refHash]) revert DuplicateReference(refId);
        _referenceUsed[refHash] = true;

        _contributions.push(
            Contribution({
                id: _contributions.length + 1,
                eventId: eventId,
                contributor: contributor,
                label: label,
                amount: amount,
                kind: kind,
                refId: refId,
                recordedBy: msg.sender,
                timestamp: uint64(block.timestamp)
            })
        );
        contributionId = _contributions.length;
        _eventContributionIds[eventId].push(contributionId);
        _events[eventId].totalContributions += amount;

        emit ContributionRecorded(contributionId, eventId, contributor, amount, kind, refId, msg.sender);
    }

    // ---------------------------------------------------------------- expenses
    /// @notice Event organizer submits an expense request (status = Pending).
    function submitExpense(
        uint256 eventId,
        string calldata category,
        string calldata description,
        uint256 amount,
        string calldata receiptRef
    ) external eventMustBeActive(eventId) onlyEventOrganizer(eventId) returns (uint256 expenseId) {
        if (amount == 0) revert InvalidAmount();
        _requireText(category, 1, MAX_SHORT, "category");
        _requireText(description, 1, MAX_TEXT, "description");
        _requireText(receiptRef, 1, MAX_SHORT, "receiptRef");

        _expenses.push(
            Expense({
                id: _expenses.length + 1,
                eventId: eventId,
                category: category,
                description: description,
                amount: amount,
                submitter: msg.sender,
                receiptRef: receiptRef,
                submittedAt: uint64(block.timestamp),
                status: ExpenseStatus.Pending,
                reviewer: address(0),
                reviewedAt: 0,
                reviewNote: ""
            })
        );
        expenseId = _expenses.length;
        _eventExpenseIds[eventId].push(expenseId);
        _events[eventId].totalPending += amount;

        emit ExpenseSubmitted(expenseId, eventId, msg.sender, category, amount, receiptRef);
    }

    /// @notice Approver approves a pending expense. Limits are re-checked now.
    function approveExpense(uint256 expenseId) external onlyRole(APPROVER_ROLE) {
        Expense storage ex = _getExpenseStorage(expenseId);
        FundEvent storage ev = _events[ex.eventId];
        if (ev.status != EventStatus.Active) revert EventNotActive(ex.eventId);
        if (ex.status != ExpenseStatus.Pending) revert ExpenseNotPending(expenseId);
        if (ex.submitter == msg.sender) revert SelfApprovalNotAllowed();

        uint256 newApproved = ev.totalApproved + ex.amount;
        if (newApproved > ev.budget) revert ExceedsBudget(newApproved, ev.budget);
        if (newApproved > ev.totalContributions) revert ExceedsAvailableBalance(newApproved, ev.totalContributions);

        ex.status = ExpenseStatus.Approved;
        ex.reviewer = msg.sender;
        ex.reviewedAt = uint64(block.timestamp);
        ev.totalPending -= ex.amount;
        ev.totalApproved = newApproved;

        emit ExpenseApproved(expenseId, ex.eventId, msg.sender, ex.amount);
    }

    /// @notice Approver rejects a pending expense; a non-empty reason is mandatory.
    function rejectExpense(uint256 expenseId, string calldata reason) external onlyRole(APPROVER_ROLE) {
        Expense storage ex = _getExpenseStorage(expenseId);
        FundEvent storage ev = _events[ex.eventId];
        if (ev.status != EventStatus.Active) revert EventNotActive(ex.eventId);
        if (ex.status != ExpenseStatus.Pending) revert ExpenseNotPending(expenseId);
        if (ex.submitter == msg.sender) revert SelfApprovalNotAllowed();
        _requireText(reason, 1, MAX_TEXT, "reason");

        ex.status = ExpenseStatus.Rejected;
        ex.reviewer = msg.sender;
        ex.reviewedAt = uint64(block.timestamp);
        ex.reviewNote = reason;
        ev.totalPending -= ex.amount;
        ev.totalRejected += ex.amount;

        emit ExpenseRejected(expenseId, ex.eventId, msg.sender, ex.amount, reason);
    }

    // ---------------------------------------------------------------- views (open to everyone)
    function getEventCount() external view returns (uint256) {
        return _eventIds.length;
    }

    function getEventIds() external view returns (uint256[] memory) {
        return _eventIds;
    }

    function getFundEvent(uint256 eventId) external view eventMustExist(eventId) returns (FundEvent memory) {
        return _events[eventId];
    }

    function eventExists(uint256 eventId) external view returns (bool) {
        return _eventExists[eventId];
    }

    function getSummary(uint256 eventId) public view eventMustExist(eventId) returns (Summary memory s) {
        FundEvent storage ev = _events[eventId];
        s.totalContributions = ev.totalContributions;
        s.totalApproved = ev.totalApproved;
        s.totalPending = ev.totalPending;
        s.totalRejected = ev.totalRejected;
        // totalApproved <= totalContributions is enforced at approval, so no underflow.
        s.remainingBalance = ev.totalContributions - ev.totalApproved;
        s.budgetUtilizationBps = ev.budget == 0 ? 0 : (ev.totalApproved * 10_000) / ev.budget;
        s.fundingProgressBps = ev.fundraisingTarget == 0 ? 0 : (ev.totalContributions * 10_000) / ev.fundraisingTarget;
    }

    function getContributionCount() external view returns (uint256) {
        return _contributions.length;
    }

    function getContribution(uint256 contributionId) external view returns (Contribution memory) {
        if (contributionId == 0 || contributionId > _contributions.length) revert ContributionNotFound(contributionId);
        return _contributions[contributionId - 1];
    }

    function getEventContributionIds(uint256 eventId) external view eventMustExist(eventId) returns (uint256[] memory) {
        return _eventContributionIds[eventId];
    }

    function getExpenseCount() external view returns (uint256) {
        return _expenses.length;
    }

    function getExpense(uint256 expenseId) external view returns (Expense memory) {
        return _getExpenseStorage(expenseId);
    }

    function getEventExpenseIds(uint256 eventId) external view eventMustExist(eventId) returns (uint256[] memory) {
        return _eventExpenseIds[eventId];
    }

    function isReferenceUsed(string calldata refId) external view returns (bool) {
        return _referenceUsed[keccak256(bytes(refId))];
    }

    // ---------------------------------------------------------------- internals
    function _getExpenseStorage(uint256 expenseId) private view returns (Expense storage) {
        if (expenseId == 0 || expenseId > _expenses.length) revert ExpenseNotFound(expenseId);
        return _expenses[expenseId - 1];
    }

    function _requireText(string calldata s, uint256 minLen, uint256 maxLen, string memory field) private pure {
        uint256 len = bytes(s).length;
        if (len < minLen || len > maxLen) revert InvalidText(field);
    }
}
