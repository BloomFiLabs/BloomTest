// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/LiquidityRangeManager.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

// Helper interface for ERC20 on fork
interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

contract LiquidityRangeManagerForkTest is Test {
    LiquidityRangeManager public manager;
    
    // Base Mainnet Addresses
    address constant NONFUNGIBLE_POSITION_MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    
    // WETH/USDC Pool (0.05%)
    address constant POOL_WETH_USDC_05 = 0xd0b53D9277642d899DF5C87A3966A349A798F224; 
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    
    address constant USDC_WHALE = 0xd0b53D9277642d899DF5C87A3966A349A798F224; // Uniswap V3 WETH/USDC Pool
    address constant WETH_WHALE = 0x4200000000000000000000000000000000000006; // WETH contract often holds funds or wrapped ether
    
    function setUp() public {
        string memory rpcUrl = "https://base-mainnet.infura.io/v3/5ce3f0a2d7814e3c9da96f8e8ebf4d0c";
        vm.createSelectFork(rpcUrl);
        
        manager = new LiquidityRangeManager(NONFUNGIBLE_POSITION_MANAGER);
    }
    
    function testForkIncreaseAndDecreaseLiquidity() public {
        address user = address(0xABC);
        
        // Fund user
        uint256 amountUSDC = 2000 * 1e6; 
        uint256 amountWETH = 1 ether;
        
        vm.prank(USDC_WHALE);
        IERC20Like(USDC).transfer(user, amountUSDC);
        
        // For WETH, we can just deal ETH to WETH contract and withdraw or simulate wrapping.
        // Easier: Deal ETH to user and deposit to WETH
        vm.deal(user, 10 ether);
        vm.startPrank(user);
        (bool success,) = WETH.call{value: 2 ether}(""); 
        require(success, "WETH deposit failed");
        
        IERC20Like(USDC).approve(address(manager), type(uint256).max);
        IERC20Like(WETH).approve(address(manager), type(uint256).max);
        
        // 1. Increase Liquidity (Open Position)
        // ±10% range
        LiquidityRangeManager.ManageLiquidityParams memory params = LiquidityRangeManager.ManageLiquidityParams({
            pool: POOL_WETH_USDC_05,
            rangePct1e5: 1_000_000, // 10%
            amount0Desired: 1 ether, // WETH (token0 usually WETH or check sort order)
            amount1Desired: 1800 * 1e6, // USDC
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 hours
        });
        
        // Check token ordering for this pool to match amounts correctly
        // Base WETH: 0x42...06, USDC: 0x83...13. 0x42 < 0x83, so Token0 = WETH, Token1 = USDC.
        
        (uint256 tokenId, uint128 liquidity,,) = manager.increaseLiquidity(params);
        
        assertTrue(tokenId > 0, "Token ID should be created");
        assertTrue(liquidity > 0, "Liquidity should be > 0");
        
        (uint256 storedTokenId, uint128 storedLiq,,) = manager.getManagedPosition(user, POOL_WETH_USDC_05, 1_000_000);
        assertEq(storedTokenId, tokenId);
        assertEq(storedLiq, liquidity);
        
        // 2. Decrease Liquidity (Close Position)
        LiquidityRangeManager.DecreaseLiquidityParams memory decParams = LiquidityRangeManager.DecreaseLiquidityParams({
            pool: POOL_WETH_USDC_05,
            rangePct1e5: 1_000_000,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 1 hours
        });
        
        uint256 balWethBefore = IERC20Like(WETH).balanceOf(user);
        uint256 balUsdcBefore = IERC20Like(USDC).balanceOf(user);
        
        (uint256 amount0, uint256 amount1) = manager.decreaseLiquidity(decParams);
        
        assertTrue(amount0 > 0 || amount1 > 0, "Should return some tokens");
        assertEq(IERC20Like(WETH).balanceOf(user), balWethBefore + amount0);
        assertEq(IERC20Like(USDC).balanceOf(user), balUsdcBefore + amount1);
        
        vm.stopPrank();
    }
}

