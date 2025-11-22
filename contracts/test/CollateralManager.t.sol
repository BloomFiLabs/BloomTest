// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CollateralManager.sol";

contract CollateralManagerTest is Test {
    CollateralManager public manager;
    MockERC20 public token;
    MockAavePool public pool;

    address public user = address(0xBEEF);

    function setUp() public {
        token = new MockERC20("Collateral Token", "COLL");
        pool = new MockAavePool();

        manager = new CollateralManager(address(pool));

        token.mint(user, 1_000 ether);

        vm.prank(user);
        token.approve(address(manager), type(uint256).max);
    }

    function testDepositCollateralCreatesPosition() public {
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: address(token),
            collateralPct1e5: 250_000, // 2.5%
            amountDesired: 20 ether,
            amountMin: 0,
            referralCode: 0
        });

        vm.prank(user);
        uint256 supplied = manager.depositCollateral(params);

        assertEq(supplied, 20 ether);

        (uint256 collateralAmount, ) = manager.getManagedCollateral(user, address(token), params.collateralPct1e5);
        assertEq(collateralAmount, 20 ether);
    }

    function testDepositCollateralAddsToExistingPosition() public {
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: address(token),
            collateralPct1e5: 500_000, // 5%
            amountDesired: 15 ether,
            amountMin: 0,
            referralCode: 0
        });

        vm.prank(user);
        manager.depositCollateral(params);

        params.amountDesired = 10 ether;

        vm.prank(user);
        uint256 added = manager.depositCollateral(params);

        assertEq(added, 10 ether);

        (uint256 collateralAmount, ) = manager.getManagedCollateral(user, address(token), params.collateralPct1e5);
        assertEq(collateralAmount, 25 ether);
    }

    function testWithdrawCollateralReturnsFundsAndCleansPosition() public {
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: address(token),
            collateralPct1e5: 100_000, // 1%
            amountDesired: 12 ether,
            amountMin: 0,
            referralCode: 0
        });

        vm.prank(user);
        manager.depositCollateral(params);

        CollateralManager.DecreaseCollateralParams memory decParams = CollateralManager.DecreaseCollateralParams({
            asset: address(token),
            collateralPct1e5: params.collateralPct1e5,
            amount: 12 ether,
            amountMin: 0
        });

        vm.prank(user);
        uint256 withdrawn = manager.withdrawCollateral(decParams);

        assertEq(withdrawn, 12 ether);

        (uint256 collateralAmount, ) = manager.getManagedCollateral(user, address(token), params.collateralPct1e5);
        assertEq(collateralAmount, 0);
    }

    function testBorrowLiquidityTracksDebtAndSendsFunds() public {
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: address(token),
            collateralPct1e5: 400_000,
            amountDesired: 30 ether,
            amountMin: 0,
            referralCode: 0
        });

        vm.prank(user);
        manager.depositCollateral(params);

        CollateralManager.BorrowParams memory borrowParams = CollateralManager.BorrowParams({
            collateralAsset: address(token),
            collateralPct1e5: params.collateralPct1e5,
            debtAsset: address(token),
            amount: 10 ether,
            interestRateMode: 2,
            referralCode: 0,
            recipient: user
        });

        uint256 userBalanceBefore = token.balanceOf(user);

        vm.prank(user);
        manager.borrowLiquidity(borrowParams);

        assertEq(token.balanceOf(user), userBalanceBefore + 10 ether);

        uint256 debt = manager.getManagedDebt(
            user,
            address(token),
            params.collateralPct1e5,
            address(token),
            2
        );
        assertEq(debt, 10 ether);
    }

    function testRepayDebtReducesOutstanding() public {
        CollateralManager.ManageCollateralParams memory params = CollateralManager.ManageCollateralParams({
            asset: address(token),
            collateralPct1e5: 150_000,
            amountDesired: 40 ether,
            amountMin: 0,
            referralCode: 0
        });

        vm.prank(user);
        manager.depositCollateral(params);

        CollateralManager.BorrowParams memory borrowParams = CollateralManager.BorrowParams({
            collateralAsset: address(token),
            collateralPct1e5: params.collateralPct1e5,
            debtAsset: address(token),
            amount: 15 ether,
            interestRateMode: 2,
            referralCode: 0,
            recipient: user
        });

        vm.prank(user);
        manager.borrowLiquidity(borrowParams);

        vm.prank(user);
        token.approve(address(manager), 15 ether);

        CollateralManager.RepayParams memory repayParams = CollateralManager.RepayParams({
            collateralAsset: address(token),
            collateralPct1e5: params.collateralPct1e5,
            debtAsset: address(token),
            amount: 15 ether,
            interestRateMode: 2
        });

        vm.prank(user);
        uint256 repaid = manager.repayDebt(repayParams);

        assertEq(repaid, 15 ether);

        uint256 debt = manager.getManagedDebt(
            user,
            address(token),
            params.collateralPct1e5,
            address(token),
            2
        );
        assertEq(debt, 0);
    }
}

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowedAmount = allowance[from][msg.sender];
        require(allowedAmount >= amount, "ALLOWANCE");
        require(balanceOf[from] >= amount, "BALANCE");
        allowance[from][msg.sender] = allowedAmount - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockAavePool {
    mapping(address => mapping(address => uint256)) public collateralBalances; // asset => account => amount
    mapping(address => mapping(address => mapping(uint256 => uint256))) public debts; // account => asset => rate => amount

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(amount > 0, "ZERO_AMOUNT");
        MockERC20(asset).transferFrom(msg.sender, address(this), amount);
        collateralBalances[asset][onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        uint256 bal = collateralBalances[asset][msg.sender];
        require(bal >= amount, "INSUFFICIENT");
        collateralBalances[asset][msg.sender] = bal - amount;
        MockERC20(asset).transfer(to, amount);
        return amount;
    }

    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16,
        address onBehalfOf
    ) external {
        require(amount > 0, "ZERO_AMOUNT");
        debts[onBehalfOf][asset][interestRateMode] += amount;
        MockERC20(asset).mint(msg.sender, amount);
    }

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256) {
        MockERC20(asset).transferFrom(msg.sender, address(this), amount);
        uint256 outstanding = debts[onBehalfOf][asset][interestRateMode];
        require(outstanding >= amount, "EXCEEDS_DEBT");
        debts[onBehalfOf][asset][interestRateMode] = outstanding - amount;
        return amount;
    }
}

