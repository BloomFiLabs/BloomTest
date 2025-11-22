// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/LiquidityRangeManager.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";

contract LiquidityRangeManagerTest is Test {
    LiquidityRangeManager public manager;
    MockERC20 public token0;
    MockERC20 public token1;
    MockPool public pool;
    MockPositionManager public positionManager;

    address public user = address(0xBEEF);

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0");
        token1 = new MockERC20("Token1", "TK1");
        pool = new MockPool(address(token0), address(token1), 3000, 60, 0);
        positionManager = new MockPositionManager();

        manager = new LiquidityRangeManager(address(positionManager));

        token0.mint(user, 1_000 ether);
        token1.mint(user, 1_000 ether);

        vm.prank(user);
        token0.approve(address(manager), type(uint256).max);
        vm.prank(user);
        token1.approve(address(manager), type(uint256).max);
    }

    function testIncreaseLiquidityCreatesManagedPosition() public {
        LiquidityRangeManager.ManageLiquidityParams memory params = LiquidityRangeManager.ManageLiquidityParams({
            pool: address(pool),
            rangePct1e5: 500_000, // ±5%
            amount0Desired: 10 ether,
            amount1Desired: 10 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 days
        });

        vm.prank(user);
        (uint256 tokenId, uint128 liquidityAdded, , ) = manager.increaseLiquidity(params);

        assertEq(tokenId, 1);
        assertEq(liquidityAdded, 20 ether);

        (uint256 storedTokenId, uint128 liquidity, , ) = manager.getManagedPosition(
            user,
            address(pool),
            params.rangePct1e5
        );
        assertEq(storedTokenId, tokenId);
        assertEq(liquidity, liquidityAdded);
    }

    function testIncreaseLiquidityAddsToExistingPosition() public {
        LiquidityRangeManager.ManageLiquidityParams memory params = LiquidityRangeManager.ManageLiquidityParams({
            pool: address(pool),
            rangePct1e5: 100_000, // ±1%
            amount0Desired: 5 ether,
            amount1Desired: 5 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 days
        });

        vm.prank(user);
        (uint256 tokenId, uint128 firstLiquidity, , ) = manager.increaseLiquidity(params);

        params.amount0Desired = 3 ether;
        params.amount1Desired = 7 ether;

        vm.prank(user);
        (uint256 secondTokenId, uint128 liquidityAdded, , ) = manager.increaseLiquidity(params);

        assertEq(tokenId, secondTokenId);
        assertEq(firstLiquidity, 10 ether);
        assertEq(liquidityAdded, 10 ether);

        ( , uint128 totalLiquidity, , ) = manager.getManagedPosition(
            user,
            address(pool),
            params.rangePct1e5
        );
        assertEq(totalLiquidity, 20 ether);
    }

    function testDecreaseLiquidityReturnsFundsAndCleansPosition() public {
        LiquidityRangeManager.ManageLiquidityParams memory params = LiquidityRangeManager.ManageLiquidityParams({
            pool: address(pool),
            rangePct1e5: 200_000, // ±2%
            amount0Desired: 8 ether,
            amount1Desired: 8 ether,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 days
        });

        vm.prank(user);
        manager.increaseLiquidity(params);

        LiquidityRangeManager.DecreaseLiquidityParams memory decParams = LiquidityRangeManager.DecreaseLiquidityParams({
            pool: address(pool),
            rangePct1e5: params.rangePct1e5,
            liquidity: uint128(16 ether),
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 days
        });

        vm.prank(user);
        (uint256 amount0Returned, uint256 amount1Returned) = manager.decreaseLiquidity(decParams);

        assertEq(amount0Returned, 8 ether);
        assertEq(amount1Returned, 8 ether);

        (uint256 storedTokenId, uint128 liquidity, , ) = manager.getManagedPosition(
            user,
            address(pool),
            params.rangePct1e5
        );
        assertEq(storedTokenId, 0);
        assertEq(liquidity, 0);
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

contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee;
    int24 public spacing;
    int24 public currentTick;

    constructor(address _token0, address _token1, uint24 _fee, int24 _spacing, int24 _initialTick) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        spacing = _spacing;
        currentTick = _initialTick;
    }

    function setTick(int24 newTick) external {
        currentTick = newTick;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(currentTick);
        tick = currentTick;
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        feeProtocol = 0;
        unlocked = true;
    }

    function tickSpacing() external view returns (int24) {
        return spacing;
    }
}

contract MockPositionManager is INonfungiblePositionManagerLike {
    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        address owner;
    }

    mapping(uint256 => Position) public positions;
    uint256 public nextId = 1;

    function mint(MintParams calldata params)
        external
        override
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        tokenId = nextId++;
        liquidity = uint128(params.amount0Desired + params.amount1Desired);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        _pull(params.token0, amount0);
        _pull(params.token1, amount1);

        positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            owner: params.recipient
        });
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        override
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        Position storage position = positions[params.tokenId];
        liquidity = uint128(params.amount0Desired + params.amount1Desired);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        _pull(position.token0, amount0);
        _pull(position.token1, amount1);

        position.liquidity += liquidity;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        override
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage position = positions[params.tokenId];
        require(position.liquidity >= params.liquidity, "INSUFFICIENT");
        position.liquidity -= params.liquidity;

        amount0 = params.liquidity / 2;
        amount1 = params.liquidity / 2;

        position.tokensOwed0 += uint128(amount0);
        position.tokensOwed1 += uint128(amount1);
    }

    function collect(CollectParams calldata params) external override returns (uint256 amount0, uint256 amount1) {
        Position storage position = positions[params.tokenId];
        amount0 = _min(params.amount0Max, position.tokensOwed0);
        amount1 = _min(params.amount1Max, position.tokensOwed1);

        position.tokensOwed0 -= uint128(amount0);
        position.tokensOwed1 -= uint128(amount1);

        MockERC20(position.token0).transfer(params.recipient, amount0);
        MockERC20(position.token1).transfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external override {
        delete positions[tokenId];
    }

    function _pull(address token, uint256 amount) internal {
        if (amount == 0) return;
        MockERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    function _min(uint128 a, uint128 b) internal pure returns (uint128) {
        return a < b ? a : b;
    }
}


