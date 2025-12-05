pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract Dao2DaoInteractionFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        euint32 encryptedTotalVotesFor; // euint32(0) by default
        euint32 encryptedTotalVotesAgainst; // euint32(0) by default
        euint32 encryptedTotalVotesAbstain; // euint32(0) by default
        uint256 proposalDeadline;
        mapping(address => bool) hasVoted;
    }

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId, uint256 proposalDeadline);
    event BatchClosed(uint256 indexed batchId);
    event VoteSubmitted(uint256 indexed batchId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalFor, uint256 totalAgainst, uint256 totalAbstain);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error BatchNotOpen();
    error AlreadyVoted();
    error ProposalDeadlineNotReached();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        paused = false;
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 0;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused == paused) return;
        if (_paused) {
            paused = true;
            emit ContractPaused();
        } else {
            paused = false;
            emit ContractUnpaused();
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function openBatch(uint256 proposalDeadline) external onlyOwner whenNotPaused {
        currentBatchId++;
        Batch storage batch = batches[currentBatchId];
        batch.id = currentBatchId;
        batch.isOpen = true;
        batch.proposalDeadline = proposalDeadline;

        // Initialize encrypted vote totals to 0
        batch.encryptedTotalVotesFor = FHE.asEuint32(0);
        batch.encryptedTotalVotesAgainst = FHE.asEuint32(0);
        batch.encryptedTotalVotesAbstain = FHE.asEuint32(0);

        emit BatchOpened(currentBatchId, proposalDeadline);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) {
            revert InvalidBatch();
        }
        Batch storage batch = batches[batchId];
        batch.isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitVote(
        uint256 batchId,
        euint32 encryptedVoteFor,
        euint32 encryptedVoteAgainst,
        euint32 encryptedVoteAbstain
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchNotOpen();
        if (block.timestamp < batch.proposalDeadline) revert ProposalDeadlineNotReached();
        if (batch.hasVoted[msg.sender]) revert AlreadyVoted();

        _initIfNeeded(encryptedVoteFor);
        _initIfNeeded(encryptedVoteAgainst);
        _initIfNeeded(encryptedVoteAbstain);

        batch.encryptedTotalVotesFor = FHE.add(batch.encryptedTotalVotesFor, encryptedVoteFor);
        batch.encryptedTotalVotesAgainst = FHE.add(batch.encryptedTotalVotesAgainst, encryptedVoteAgainst);
        batch.encryptedTotalVotesAbstain = FHE.add(batch.encryptedTotalVotesAbstain, encryptedVoteAbstain);

        batch.hasVoted[msg.sender] = true;
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit VoteSubmitted(batchId, msg.sender);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || batches[batchId].isOpen) {
            revert InvalidBatch();
        }
        Batch storage batch = batches[batchId];

        euint32 memory ctFor = batch.encryptedTotalVotesFor;
        euint32 memory ctAgainst = batch.encryptedTotalVotesAgainst;
        euint32 memory ctAbstain = batch.encryptedTotalVotesAbstain;

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(ctFor);
        cts[1] = FHE.toBytes32(ctAgainst);
        cts[2] = FHE.toBytes32(ctAbstain);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        DecryptionContext storage ctx = decryptionContexts[requestId];
        Batch storage batch = batches[ctx.batchId];

        // Rebuild ciphertexts from current contract storage for state verification
        euint32 memory ctFor = batch.encryptedTotalVotesFor;
        euint32 memory ctAgainst = batch.encryptedTotalVotesAgainst;
        euint32 memory ctAbstain = batch.encryptedTotalVotesAbstain;

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(ctFor);
        currentCts[1] = FHE.toBytes32(ctAgainst);
        currentCts[2] = FHE.toBytes32(ctAbstain);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != ctx.stateHash) revert StateMismatch();
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 totalFor = abi.decode(cleartexts[0:32], (uint256));
        uint256 totalAgainst = abi.decode(cleartexts[32:64], (uint256));
        uint256 totalAbstain = abi.decode(cleartexts[64:96], (uint256));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalFor, totalAgainst, totalAbstain);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 cipher) internal pure {
        if (!FHE.isInitialized(cipher)) revert("FHE: ciphertext not initialized");
    }

    function _requireInitialized(euint32 cipher) internal pure {
        if (!FHE.isInitialized(cipher)) revert("FHE: ciphertext not initialized");
    }
}