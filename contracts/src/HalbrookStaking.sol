// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title Halbrook staking
/// @notice Stake $HALBROOK, earn ETH. No lockup: withdraw anytime.
///         The owner funds rewards in ETH; each funding is streamed over 24 hours,
///         pro rata to each staker's weight and time staked.
///         Tokens staked during the launch window count double for as long as they stay staked.
///         The owner can only add rewards: it can never touch staked tokens or earned ETH.
contract HalbrookStaking {
    IERC20 public immutable token;
    uint256 public constant DURATION = 24 hours;
    uint256 public immutable boostEnd;          // tokens staked before this time weigh x2

    address public owner;
    address public pendingOwner;

    uint256 public periodFinish;
    uint256 public rewardRate;                  // wei per second, scaled by 1e18
    uint256 public lastUpdate;
    uint256 public rewardPerWeightStored;       // scaled by 1e18 (on top of the rate scale)
    uint256 public queued;                      // wei streamed while nobody was staked, added to the next funding (scaled by 1e18)

    uint256 public totalStaked;
    uint256 public totalWeight;
    mapping(address => uint256) public staked;  // all tokens
    mapping(address => uint256) public boosted; // part of `staked` that weighs x2
    mapping(address => uint256) public paidPerWeight;
    mapping(address => uint256) public rewards; // earned, not yet claimed (wei)

    uint256 private locked = 1;

    event Staked(address indexed user, uint256 amount, bool boosted);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event Funded(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event OwnerProposed(address indexed owner);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error Zero();
    error TooMuch();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (locked != 1) revert Reentrant(); locked = 2; _; locked = 1; }
    modifier update(address a) {
        uint256 t = lastApplicable();
        if (totalWeight == 0) queued += (t - lastUpdate) * rewardRate;
        else rewardPerWeightStored = rewardPerWeight();
        lastUpdate = t;
        if (a != address(0)) {
            rewards[a] = earned(a);
            paidPerWeight[a] = rewardPerWeightStored;
        }
        _;
    }

    constructor(IERC20 _token, uint256 boostSeconds) {
        token = _token;
        owner = msg.sender;
        boostEnd = block.timestamp + boostSeconds;
        emit OwnerChanged(msg.sender);
    }

    // ---------- views ----------
    function lastApplicable() public view returns (uint256) { return block.timestamp < periodFinish ? block.timestamp : periodFinish; }

    function rewardPerWeight() public view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + (lastApplicable() - lastUpdate) * rewardRate * 1e18 / totalWeight;
    }

    function weightOf(address a) public view returns (uint256) { return staked[a] + boosted[a]; }

    function earned(address a) public view returns (uint256) {
        return rewards[a] + weightOf(a) * (rewardPerWeight() - paidPerWeight[a]) / 1e36;
    }

    /// @notice ETH per second currently streamed to all stakers
    function ethPerSecond() external view returns (uint256) { return block.timestamp < periodFinish ? rewardRate / 1e18 : 0; }

    // ---------- stakers ----------
    function stake(uint256 amount) external nonReentrant update(msg.sender) {
        if (amount == 0) revert Zero();
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 got = token.balanceOf(address(this)) - before;   // what actually arrived
        if (got == 0) revert Zero();
        bool b = block.timestamp < boostEnd;
        staked[msg.sender] += got;
        totalStaked += got;
        if (b) boosted[msg.sender] += got;
        totalWeight += b ? 2 * got : got;
        emit Staked(msg.sender, got, b);
    }

    function withdraw(uint256 amount) public nonReentrant update(msg.sender) {
        if (amount == 0) revert Zero();
        uint256 s = staked[msg.sender];
        if (amount > s) revert TooMuch();
        uint256 plain = s - boosted[msg.sender];
        uint256 fromBoost = amount > plain ? amount - plain : 0;   // unboosted tokens leave first
        staked[msg.sender] = s - amount;
        boosted[msg.sender] -= fromBoost;
        totalStaked -= amount;
        totalWeight -= amount + fromBoost;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant update(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r == 0) return;
        rewards[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{ value: r }("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, r);
    }

    function exit() external {
        uint256 s = staked[msg.sender];
        if (s > 0) withdraw(s);
        claim();
    }

    // ---------- owner ----------
    /// @notice Send ETH to start a new 24h reward stream. Whatever was left of the current one is rolled in.
    function fund() external payable onlyOwner update(address(0)) {
        if (msg.value == 0) revert Zero();
        uint256 total = msg.value * 1e18 + queued;
        queued = 0;
        if (block.timestamp < periodFinish) total += (periodFinish - block.timestamp) * rewardRate;
        rewardRate = total / DURATION;
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + DURATION;
        emit Funded(msg.value, rewardRate, periodFinish);
    }

    function proposeOwner(address o) external onlyOwner { pendingOwner = o; emit OwnerProposed(o); }
    function acceptOwner() external { if (msg.sender != pendingOwner) revert NotOwner(); owner = pendingOwner; pendingOwner = address(0); emit OwnerChanged(owner); }

    receive() external payable { revert(); }
}
