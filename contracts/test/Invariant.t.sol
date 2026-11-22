// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "forge-std/Test.sol";
import "../src/HalbrookStaking.sol";
import { Tok } from "./HalbrookStaking.t.sol";

contract Handler is Test {
    HalbrookStaking public s; Tok public t; address[4] public who; uint256 public funded; uint256 public claimed;
    constructor(HalbrookStaking _s, Tok _t) { s = _s; t = _t;
        for (uint i; i < 4; i++) { who[i] = address(uint160(0x1000 + i)); t.mint(who[i], 1e27); vm.prank(who[i]); t.approve(address(s), type(uint256).max); } }
    function stake(uint8 i, uint256 v) external { address u = who[i % 4]; uint256 b = t.balanceOf(u); if (b == 0) return; v = bound(v, 1, b); vm.prank(u); s.stake(v); }
    function withdraw(uint8 i, uint256 v) external { address u = who[i % 4]; uint256 st = s.staked(u); if (st == 0) return; v = bound(v, 1, st); vm.prank(u); s.withdraw(v); }
    function claim(uint8 i) external { address u = who[i % 4]; uint256 b = u.balance; vm.prank(u); s.claim(); claimed += u.balance - b; }
    function exit(uint8 i) external { address u = who[i % 4]; uint256 b = u.balance; vm.prank(u); s.exit(); claimed += u.balance - b; }
    function fund(uint256 v, uint256 d) external { v = bound(v, 1, 20 ether); d = bound(d, 1 days, 60 days); vm.deal(address(this), v); s.fund{ value: v }(d); funded += v; }
    function warp(uint32 dt) external { vm.warp(block.timestamp + bound(dt, 1, 2 days)); }
}

contract InvariantTest is Test {
    Tok t; HalbrookStaking s; Handler h;
    function setUp() public {
        vm.warp(1_000_000); t = new Tok();
        s = new HalbrookStaking(IERC20(address(t)), 1 days); h = new Handler(s, t);
        s.proposeOwner(address(h)); vm.prank(address(h)); s.acceptOwner();   // the handler is the owner, so it can fund
        targetContract(address(h));
    }
    function invariant_solvent_and_consistent() public view {
        uint256 owed; uint256 st;
        for (uint i; i < 4; i++) { address u = h.who(i); owed += s.earned(u); st += s.staked(u); }
        assertGe(address(s).balance, owed);                       // every earned wei is in the contract
        assertEq(address(s).balance + h.claimed(), h.funded());   // ETH only leaves through claims
        assertEq(st, s.totalStaked());
        assertGe(t.balanceOf(address(s)), s.totalStaked());       // every staked token is in the contract
    }
}
