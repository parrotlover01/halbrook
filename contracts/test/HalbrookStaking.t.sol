// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "forge-std/Test.sol";
import "../src/HalbrookStaking.sol";

contract Tok {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 v) external { balanceOf[a] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true; }
}

contract Thief {
    HalbrookStaking s; Tok t; uint256 n;
    constructor(HalbrookStaking _s, Tok _t) { s = _s; t = _t; }
    function go(uint256 v) external { t.approve(address(s), v); s.stake(v); }
    function take() external { s.claim(); }
    receive() external payable { if (n++ < 3) s.claim(); }
}

contract StakingTest is Test {
    Tok t; HalbrookStaking s; address A = address(0xA11); address B = address(0xB22); address C = address(0xC33);
    function setUp() public {
        vm.warp(1_000_000);
        t = new Tok(); s = new HalbrookStaking(IERC20(address(t)), 1 days);
        for (uint i; i < 3; i++) { address u = [A, B, C][i]; t.mint(u, 1e30); vm.prank(u); t.approve(address(s), type(uint256).max); }
        vm.deal(address(this), 1000 ether);
    }
    function stake(address u, uint256 v) internal { vm.prank(u); s.stake(v); }
    function claim(address u) internal returns (uint256 g) { uint256 b = u.balance; vm.prank(u); s.claim(); g = u.balance - b; }
    function near(uint256 a, uint256 b) internal pure { assertApproxEqRel(a, b, 1e14); }   // 0.01%

    function test_single_gets_everything() public {
        vm.warp(block.timestamp + 2 days);            // past the boost
        stake(A, 100e18); s.fund{ value: 1 ether }(1 days);
        vm.warp(block.timestamp + 1 days); near(claim(A), 1 ether);
        vm.warp(block.timestamp + 5 days); assertEq(claim(A), 0);
    }
    function test_boost_streams_twice_as_fast() public {
        stake(A, 100e18); s.fund{ value: 15 ether }(14 days);   // 14 days, the first one counts double: 15 shares
        vm.warp(block.timestamp + 1 days); near(s.earned(A), 2 ether);
        vm.warp(block.timestamp + 1 days); near(s.earned(A), 3 ether);
        vm.warp(block.timestamp + 12 days); near(s.earned(A), 15 ether);
        vm.warp(block.timestamp + 30 days); near(claim(A), 15 ether);
    }
    function test_boost_shared_pro_rata() public {
        stake(A, 300e18); stake(B, 100e18); s.fund{ value: 15 ether }(14 days);
        vm.warp(block.timestamp + 1 days); near(s.earned(A), 1.5 ether); near(s.earned(B), 0.5 ether);
    }
    function test_fund_mid_boost_and_after() public {
        stake(A, 1e18); vm.warp(block.timestamp + 12 hours);
        s.fund{ value: 5 ether }(2 days);                       // 12h boosted (=24h) + 36h plain: 60 reward-hours
        vm.warp(block.timestamp + 12 hours); near(s.earned(A), 2 ether);
        vm.warp(block.timestamp + 36 hours); near(s.earned(A), 5 ether);
    }
    function test_duration_bounds() public {
        vm.expectRevert(HalbrookStaking.BadDuration.selector); s.fund{ value: 1 ether }(1 days - 1);
        vm.expectRevert(HalbrookStaking.BadDuration.selector); s.fund{ value: 1 ether }(60 days + 1);
        vm.expectRevert(HalbrookStaking.Zero.selector); s.fund{ value: 0 }(1 days);
    }
    function test_time_weighted() public {
        vm.warp(block.timestamp + 2 days);
        stake(A, 100e18); s.fund{ value: 4 ether }(1 days);
        vm.warp(block.timestamp + 12 hours); stake(B, 100e18);
        vm.warp(block.timestamp + 12 hours);
        near(claim(A), 3 ether); near(claim(B), 1 ether);
    }
    function test_hit_and_run_earns_nothing_extra() public {
        vm.warp(block.timestamp + 2 days);
        stake(A, 100e18); s.fund{ value: 1 ether }(1 days);
        stake(B, 1_000_000e18); vm.warp(block.timestamp + 10);
        vm.prank(B); s.exit();
        assertLt(B.balance, 0.001 ether); assertEq(t.balanceOf(B), 1e30);   // got tokens back, almost no ETH
    }
    function test_nobody_staked_rolls_over() public {
        vm.warp(block.timestamp + 2 days);
        s.fund{ value: 1 ether }(1 days); vm.warp(block.timestamp + 1 days);
        stake(A, 1e18); s.fund{ value: 1 ether }(1 days); vm.warp(block.timestamp + 1 days);
        near(claim(A), 2 ether);
    }
    function test_refund_rolls_leftover() public {
        vm.warp(block.timestamp + 2 days); stake(A, 1e18);
        s.fund{ value: 1 ether }(1 days); vm.warp(block.timestamp + 12 hours);
        s.fund{ value: 1 ether }(1 days); vm.warp(block.timestamp + 1 days);
        near(claim(A), 2 ether);
    }
    function test_withdraw_immediate_and_bounds() public {
        stake(A, 10e18); vm.prank(A); vm.expectRevert(HalbrookStaking.TooMuch.selector); s.withdraw(11e18);
        uint256 b = t.balanceOf(A); vm.prank(A); s.withdraw(10e18); assertEq(t.balanceOf(A), b + 10e18);
        assertEq(s.totalStaked(), 0);
    }
    function test_only_owner_funds() public {
        vm.deal(A, 1 ether); vm.prank(A); vm.expectRevert(HalbrookStaking.NotOwner.selector); s.fund{ value: 1 ether }(1 days);
        vm.expectRevert(); (bool ok, ) = address(s).call{ value: 1 }(""); ok;
    }
    function test_owner_transfer_two_step() public {
        s.proposeOwner(A); assertEq(s.owner(), address(this));
        vm.prank(B); vm.expectRevert(HalbrookStaking.NotOwner.selector); s.acceptOwner();
        vm.prank(A); s.acceptOwner(); assertEq(s.owner(), A);
        vm.expectRevert(HalbrookStaking.NotOwner.selector); s.fund{ value: 1 }(1 days);
    }
    function test_reentrant_claim_cannot_double() public {
        Thief th = new Thief(s, t); t.mint(address(th), 10e18);
        vm.warp(block.timestamp + 2 days); th.go(10e18); s.fund{ value: 1 ether }(1 days); vm.warp(block.timestamp + 1 days);
        vm.expectRevert(); th.take();
        assertEq(address(s).balance, 1 ether);
    }
    function testFuzz_never_pays_more_than_funded(uint96 a, uint96 b, uint32 dt1, uint32 dt2, uint64 f1, uint64 f2, uint32 d1, uint32 d2) public {
        a = uint96(bound(a, 1, 1e27)); b = uint96(bound(b, 1, 1e27));
        f1 = uint64(bound(f1, 1, 50 ether)); f2 = uint64(bound(f2, 1, 50 ether));
        dt1 = uint32(bound(dt1, 0, 3 days)); dt2 = uint32(bound(dt2, 0, 3 days)); d1 = uint32(bound(d1, 1 days, 60 days)); d2 = uint32(bound(d2, 1 days, 60 days));
        stake(A, a); s.fund{ value: f1 }(d1); vm.warp(block.timestamp + dt1);
        stake(B, b); if (a > 1) { vm.prank(A); s.withdraw(a / 2); } s.fund{ value: f2 }(d2); vm.warp(block.timestamp + dt2);
        stake(C, 1); vm.warp(block.timestamp + 61 days);
        uint256 paid = claim(A) + claim(B) + claim(C);
        assertLe(paid, uint256(f1) + f2);                       // never more than funded
        assertApproxEqAbs(paid, uint256(f1) + f2, 1e9);          // and everything gets paid out (someone was always staked)
    }
}
