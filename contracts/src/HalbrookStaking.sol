// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title Halbrook staking
/// @notice Stake $HALBROOK, earn ETH. No lockup: withdraw anytime.
///         The owner funds rewards in ETH; each funding is streamed over the number of days it picks,
///         pro rata to each staker's stake and time staked.
///         During the launch boost, rewards are streamed twice as fast.
///         The owner can only add rewards: it can never touch staked tokens or earned ETH.
contract HalbrookStaking {
    IERC20 public immutable token;
    uint256 public immutable boostEnd;          // until this time, every second streams as much as two
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 60 days;

    address public owner;
    address public pendingOwner;

    uint256 public periodFinish;
    uint256 public rewardRate;                  // wei per reward-second, scaled by 1e18
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;        // scaled by 1e36
    uint256 public queued;                      // streamed while nobody was staked, added to the next funding (wei scaled by 1e18)

    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public paidPerToken;
    mapping(address => uint256) public rewards; // earned, not yet claimed (wei)

    uint256 private locked = 1;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event Funded(uint256 amount, uint256 duration, uint256 rewardRate, uint256 periodFinish);
    event OwnerProposed(address indexed owner);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error Zero();
    error TooMuch();
    error BadDuration();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (locked != 1) revert Reentrant(); locked = 2; _; locked = 1; }
    modifier update(address a) {
        uint256 t = lastApplicable();
        if (totalStaked == 0) queued += span(lastUpdate, t) * rewardRate;
        else rewardPerTokenStored = rewardPerToken();
        lastUpdate = t;
        if (a != address(0)) {
            rewards[a] = earned(a);
            paidPerToken[a] = rewardPerTokenStored;
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
    /// @notice Reward-seconds between two times: seconds before the end of the boost count double.
    function span(uint256 a, uint256 b) public view returns (uint256) {
        if (b <= a) return 0;
        uint256 e = boostEnd;
        return (b - a) + (a < e ? (b < e ? b : e) - a : 0);
    }

    function lastApplicable() public view returns (uint256) { return block.timestamp < periodFinish ? block.timestamp : periodFinish; }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + span(lastUpdate, lastApplicable()) * rewardRate * 1e18 / totalStaked;
    }

    function earned(address a) public view returns (uint256) {
        return rewards[a] + staked[a] * (rewardPerToken() - paidPerToken[a]) / 1e36;
    }

    /// @notice ETH per second streamed to all stakers right now
    function ethPerSecond() external view returns (uint256) {
        if (block.timestamp >= periodFinish) return 0;
        return (block.timestamp < boostEnd ? 2 : 1) * rewardRate / 1e18;
    }

    // ---------- stakers ----------
    function stake(uint256 amount) external nonReentrant update(msg.sender) {
        if (amount == 0) revert Zero();
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 got = token.balanceOf(address(this)) - before;   // what actually arrived
        if (got == 0) revert Zero();
        staked[msg.sender] += got;
        totalStaked += got;
        emit Staked(msg.sender, got);
    }

    function withdraw(uint256 amount) public nonReentrant update(msg.sender) {
        if (amount == 0) revert Zero();
        if (amount > staked[msg.sender]) revert TooMuch();
        staked[msg.sender] -= amount;
        totalStaked -= amount;
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
    /// @notice Send ETH to stream it to stakers over `duration` seconds from now.
    ///         Whatever was left of the current stream is rolled in and streamed over the same new duration.
    function fund(uint256 duration) external payable onlyOwner update(address(0)) {
        if (msg.value == 0) revert Zero();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        uint256 total = msg.value * 1e18 + queued;
        queued = 0;
        if (block.timestamp < periodFinish) total += span(block.timestamp, periodFinish) * rewardRate;
        uint256 finish = block.timestamp + duration;
        rewardRate = total / span(block.timestamp, finish);
        lastUpdate = block.timestamp;
        periodFinish = finish;
        emit Funded(msg.value, duration, rewardRate, finish);
    }

    function proposeOwner(address o) external onlyOwner { pendingOwner = o; emit OwnerProposed(o); }
    function acceptOwner() external { if (msg.sender != pendingOwner) revert NotOwner(); owner = pendingOwner; pendingOwner = address(0); emit OwnerChanged(owner); }

    receive() external payable { revert(); }
}
