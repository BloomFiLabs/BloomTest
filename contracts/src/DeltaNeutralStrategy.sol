// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "./LiquidityRangeManager.sol";
import "./CollateralManager.sol";
import "./BloomStrategyVault.sol";
import "./LiquidityAmounts.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

contract DeltaNeutralStrategy is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    LiquidityRangeManager public immutable liquidityManager;
    CollateralManager public immutable collateralManager;
    ISwapRouter public immutable swapRouter;
    
    address public immutable vault;
    address public immutable usdc;
    address public immutable weth;
    address public immutable pool;
    
    uint256 public constant RANGE_WIDTH_PCT = 500_000;
    uint256 public constant TARGET_RANGE = 50_000; // 0.5%
    uint256 public constant SAFE_LTV = 60; // 60% (Lowered from 70% for safety)
    uint256 public constant SLIPPAGE_BPS = 200; // 2%
    
    uint256 public constant USER_HURDLE_BPS = 3500; // Users get first 35% APY
    uint256 public lastHarvestTimestamp;
    uint256 public cumulativeUserDeficit;
    
    // State
    uint256 public totalPrincipal; 
    mapping(address => bool) public keepers;

    event KeeperUpdated(address indexed keeper, bool active);
    event Rebalanced(uint256 timestamp, uint256 newTotalAssets);
    event EmergencyExit(uint256 timestamp, uint256 assetsPreserved);
    event ManagerFeeTaken(uint256 fee);

    constructor(
        address _vault,
        address _liquidityManager,
        address _collateralManager,
        address _swapRouter,
        address _pool,
        address _usdc,
        address _weth
    ) Ownable(msg.sender) {
        vault = _vault;
        liquidityManager = LiquidityRangeManager(_liquidityManager);
        collateralManager = CollateralManager(_collateralManager);
        swapRouter = ISwapRouter(_swapRouter);
        pool = _pool;
        usdc = _usdc;
        weth = _weth;
        lastHarvestTimestamp = block.timestamp;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "Only Vault");
        _;
    }

    modifier onlyKeeper() {
        require(keepers[msg.sender] || msg.sender == owner(), "Only Keeper or Owner");
        _;
    }

    function setKeeper(address keeper, bool active) external onlyOwner {
        keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }

    // --- Core Strategy Functions ---

    function deposit(uint256 amount) external onlyVault {
        require(amount > 0, "Deposit amount > 0");
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        _openPosition(amount);
    }

    function withdraw(uint256 amount) external onlyVault {
        _unwindPosition();
        
        // 3. Withdraw Collateral (Crucial Fix)
        // Withdraw enough to cover everything or just withdraw ALL collateral to be safe/simple.
        // Since _unwindPosition closes everything, we should pull all collateral.
        // However, we might have some dust left in Aave.
        // Let's try to withdraw ALL managed collateral.
        (uint256 currentCollateral,) = collateralManager.getManagedCollateral(address(this), usdc, 100_000);
        if (currentCollateral > 0) {
             CollateralManager.DecreaseCollateralParams memory dParams = CollateralManager.DecreaseCollateralParams({
                asset: usdc,
                collateralPct1e5: 100_000,
                amount: currentCollateral, 
                amountMin: 0
            });
            try collateralManager.withdrawCollateral(dParams) {} catch {
                 // Fallback
                 CollateralManager.DecreaseCollateralParams memory dParamsMax = CollateralManager.DecreaseCollateralParams({
                    asset: usdc,
                    collateralPct1e5: 100_000,
                    amount: type(uint256).max, 
                    amountMin: 0
                });
                try collateralManager.withdrawCollateral(dParamsMax) {} catch {}
            }
        }

        // 4. Transfer back
        uint256 finalBal = IERC20(usdc).balanceOf(address(this));
        uint256 toTransfer = finalBal > amount ? amount : finalBal; 
        
        if (toTransfer > 0) {
            IERC20(usdc).safeTransfer(msg.sender, toTransfer); 
            if (totalPrincipal >= toTransfer) {
                totalPrincipal -= toTransfer;
            } else {
                totalPrincipal = 0;
            }
        }
    }

    function claimRewards(address recipient) external returns (uint256) {
        return _harvest(recipient);
    }
    
    // For testing purposes
    function harvest() external {
        _harvest(vault);
    }

    function totalAssets() external view returns (uint256) {
        uint256 assets = 0;
        
        // 1. Idle USDC
        assets += IERC20(usdc).balanceOf(address(this));
        
        // 2. Idle WETH (converted)
        uint256 wethBal = IERC20(weth).balanceOf(address(this));
        if (wethBal > 0) assets += _convertWethToUsdc(wethBal);
        
        // 3. Collateral (USDC)
        (uint256 colVal,) = collateralManager.getManagedCollateral(address(this), usdc, 100_000);
        assets += colVal;
        
        // 4. LP Position Value
        (uint256 amount0, uint256 amount1) = liquidityManager.getPositionAmounts(address(this), pool, TARGET_RANGE);
        // amount0 is WETH, amount1 is USDC
        if (amount0 > 0) assets += _convertWethToUsdc(amount0);
        assets += amount1;
        
        // 5. Deduct Debt
        uint256 debtWeth = collateralManager.getManagedDebt(address(this), usdc, 100_000, weth, 2);
        uint256 debtUsdc = _convertWethToUsdc(debtWeth);
        
        if (assets > debtUsdc) {
            return assets - debtUsdc;
        } else {
            return 0; // Under water
        }
    }

    // --- Keeper Functions ---

    /// @notice Claims rewards to Vault, closes LP, repays debt, and keeps assets in strategy.
    /// @dev Intended for deleveraging during market volatility to preserve capital.
    function emergencyExit() external onlyKeeper {
        // 1. Claim Rewards to Vault (Profit Taking)
        _claimToVault();

        // 2. Unwind Position (Close LP, Repay Debt)
        // This leaves excess USDC/WETH in the strategy.
        _unwindPosition();
        
        // 3. Deposit excess WETH/USDC back to Collateral?
        // _unwindPosition puts collateral into `address(this)`.
        // If we want "Safe Mode", we could just leave it in `address(this)` or deposit to Aave as pure collateral.
        // Leaving it in Aave as collateral is safest (earns yield, no liquidation risk if 0 debt).
        
        // Deposit all USDC to Aave
        uint256 usdcBal = IERC20(usdc).balanceOf(address(this));
        if (usdcBal > 0) {
            IERC20(usdc).forceApprove(address(collateralManager), usdcBal);
            CollateralManager.ManageCollateralParams memory cParams = CollateralManager.ManageCollateralParams({
                asset: usdc,
                collateralPct1e5: 100_000, 
                amountDesired: usdcBal,
                amountMin: 0,
                referralCode: 0
            });
            collateralManager.depositCollateral(cParams);
        }
        
        emit EmergencyExit(block.timestamp, usdcBal);
    }

    /// @notice Claims rewards to Vault, closes old position, and opens new centered position.
    function rebalance() external onlyKeeper {
        // 1. Claim Rewards to Vault (Profit Taking)
        _claimToVault();

        // 2. Unwind
        _unwindPosition();

        // 3. Withdraw ALL Collateral to re-split efficiently
        (uint256 currentCollateral,) = collateralManager.getManagedCollateral(address(this), usdc, 100_000);
        if (currentCollateral > 0) {
             CollateralManager.DecreaseCollateralParams memory dParams = CollateralManager.DecreaseCollateralParams({
                asset: usdc,
                collateralPct1e5: 100_000,
                amount: currentCollateral, // Try full amount 
                amountMin: 0
            });
            
            try collateralManager.withdrawCollateral(dParams) {
                // success
            } catch {
                // Fallback: Try MAX withdrawal if specific amount fails due to dust/rounding
                CollateralManager.DecreaseCollateralParams memory dParamsMax = CollateralManager.DecreaseCollateralParams({
                    asset: usdc,
                    collateralPct1e5: 100_000,
                    amount: type(uint256).max, 
                    amountMin: 0
                });
                try collateralManager.withdrawCollateral(dParamsMax) {} catch {}
            }
        }

        // 4. Open New Position with all available USDC
        uint256 totalUsdc = IERC20(usdc).balanceOf(address(this));
        
        // If we have 0 USDC, it means either everything was lost (unlikely) or everything is in WETH?
        // But `_unwindPosition` swaps shortfalls.
        // If we have excess WETH, we should probably swap it to USDC too?
        // For now, let's ensure we handle 0 gracefully or require > 0.
        if (totalUsdc == 0) {
            // Check WETH balance
            uint256 totalWeth = IERC20(weth).balanceOf(address(this));
            require(totalWeth == 0, "Rebalance failed: Assets stuck in WETH");
            revert("No funds to rebalance");
        }
        
        // Update totalPrincipal to reflect current reality?
        // If we lost money, totalPrincipal should decrease.
        // If we made money (unclaimed fees sent to vault), principal might be lower than tracking?
        // We just reset principal to current assets for accurate tracking moving forward.
        totalPrincipal = totalUsdc;
        
        _openPosition(totalUsdc);
        
        emit Rebalanced(block.timestamp, totalUsdc);
    }

    // --- Internal Logic ---

    // Returns (UserShare, ManagerShare)
    function _calculateSplit(uint256 totalCollected) internal returns (uint256 userShare, uint256 managerShare) {
        uint256 timeElapsed = block.timestamp - lastHarvestTimestamp;
        if (timeElapsed == 0) return (totalCollected, 0);

        // 1. Calculate yield required to hit 35% APY for the User
        // Formula: Principal * 0.35 * (elapsed / 365 days)
        uint256 newHurdle = (totalPrincipal * USER_HURDLE_BPS * timeElapsed) / (365 days * 10000);
        
        // 2. Add deficit from previous periods
        uint256 totalUserOwed = newHurdle + cumulativeUserDeficit;
        
        if (totalCollected >= totalUserOwed) {
            // Surplus: Users recover everything, Manager takes excess
            userShare = totalUserOwed;
            managerShare = totalCollected - totalUserOwed;
            cumulativeUserDeficit = 0; // Debt cleared
        } else {
            // Deficit: Users take everything, but it's not enough
            userShare = totalCollected;
            managerShare = 0;
            // Add remaining debt to deficit
            cumulativeUserDeficit = totalUserOwed - totalCollected;
        }
        
        // Update checkpoint
        lastHarvestTimestamp = block.timestamp;
    }

    function _harvest(address recipient) internal returns (uint256) {
        // Collect raw fees
        (uint256 fees0, uint256 fees1) = liquidityManager.collectFees(pool, TARGET_RANGE, address(this));
        
        uint256 totalUsdcCollected = fees1;
        if (fees0 > 0) {
            IERC20(weth).forceApprove(address(swapRouter), fees0);
            
            // Calculate min amount out
            uint256 expectedUsdc = _convertWethToUsdc(fees0);
            uint256 minUsdc = (expectedUsdc * (10000 - SLIPPAGE_BPS)) / 10000;

            ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
                tokenIn: weth,
                tokenOut: usdc,
                fee: 500,
                recipient: address(this),
                amountIn: fees0,
                amountOutMinimum: minUsdc,
                sqrtPriceLimitX96: 0
            });
            try swapRouter.exactInputSingle(swapParams) returns (uint256 amountOut) {
                totalUsdcCollected += amountOut;
            } catch {
                IERC20(weth).safeTransfer(recipient, fees0);
            }
        }
        
        if (totalUsdcCollected > 0) {
            (uint256 userShare, uint256 managerShare) = _calculateSplit(totalUsdcCollected);
            
            if (managerShare > 0) {
                IERC20(usdc).safeTransfer(owner(), managerShare);
                emit ManagerFeeTaken(managerShare);
            }
            
            if (userShare > 0) {
                IERC20(usdc).safeTransfer(recipient, userShare);
            }
            return userShare; // Return amount sent to recipient (Vault)
        } else {
            // explicitly calculate split with 0 to update deficit tracking
            _calculateSplit(0);
        }
        
        return 0;
    }

    function _openPosition(uint256 amount) internal {
        uint256 usdcToLp = (amount * SAFE_LTV) / (100 + SAFE_LTV);
        uint256 usdcToCollateral = amount - usdcToLp;
        
        // 1. Deposit Collateral
        IERC20(usdc).forceApprove(address(collateralManager), usdcToCollateral);
        CollateralManager.ManageCollateralParams memory cParams = CollateralManager.ManageCollateralParams({
            asset: usdc,
            collateralPct1e5: 100_000, 
            amountDesired: usdcToCollateral,
            amountMin: 0,
            referralCode: 0
        });
        collateralManager.depositCollateral(cParams);

        // 2. Calculate Exact WETH to Borrow using LiquidityAmounts
        // Step A: Get Tick Range
        (int24 tickLower, int24 tickUpper) = liquidityManager.calculateRangeTicks(pool, TARGET_RANGE);
        
        // Step B: Get Current Price
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
        
        // Step C: Calculate Liquidity for our USDC amount
        // For an in-range position, USDC (Token1) covers the range [Lower, Current]
        // L = Amount1 / (sqrt(Current) - sqrt(Lower))
        // We use getLiquidityForAmount1 with (Lower, Current)
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtRatioAX96, sqrtPriceX96, usdcToLp);
        
        // Step D: Calculate required WETH (Amount0) for that same liquidity
        // For an in-range position, WETH (Token0) covers the range [Current, Upper]
        // We use getAmount0ForLiquidity with (Current, Upper)
        uint256 wethToBorrow = LiquidityAmounts.getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, liquidity);
        
        // 3. Borrow WETH
        CollateralManager.BorrowParams memory bParams = CollateralManager.BorrowParams({
            collateralAsset: usdc,
            collateralPct1e5: 100_000,
            debtAsset: weth,
            amount: wethToBorrow,
            interestRateMode: 2, // Variable
            referralCode: 0,
            recipient: address(this)
        });
        collateralManager.borrowLiquidity(bParams);

        // 4. Add Liquidity
        IERC20(weth).forceApprove(address(liquidityManager), wethToBorrow);
        IERC20(usdc).forceApprove(address(liquidityManager), usdcToLp);
        
        // Calculate minimums to prevent sandwich attacks
        // Now we can use tighter slippage because math is precise
        uint256 amount0Min = (wethToBorrow * (10000 - SLIPPAGE_BPS)) / 10000;
        uint256 amount1Min = (usdcToLp * (10000 - SLIPPAGE_BPS)) / 10000;

        LiquidityRangeManager.ManageLiquidityParams memory lpParams = LiquidityRangeManager.ManageLiquidityParams({
            pool: pool,
            rangePct1e5: TARGET_RANGE,
            amount0Desired: wethToBorrow, 
            amount1Desired: usdcToLp,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            deadline: block.timestamp
        });
        
        liquidityManager.increaseLiquidity(lpParams);
    }

    function _unwindPosition() internal {
        // 1. Remove Liquidity
        (uint256 tokenId, uint128 liquidity,,) = liquidityManager.getManagedPosition(address(this), pool, TARGET_RANGE);
        if(tokenId != 0 && liquidity > 0) {
            LiquidityRangeManager.DecreaseLiquidityParams memory decParams = LiquidityRangeManager.DecreaseLiquidityParams({
                pool: pool,
                rangePct1e5: TARGET_RANGE,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            });
            
            liquidityManager.decreaseLiquidity(decParams);
            
            // 2. Repay Debt
            uint256 wethBal = IERC20(weth).balanceOf(address(this));
            
            // Check if we need to swap USDC to WETH to cover debt shortfall (impermanent loss)
            uint256 debt = collateralManager.getManagedDebt(address(this), usdc, 100_000, weth, 2);
            
            if (wethBal < debt) {
                // Shortfall: Swap USDC to WETH to cover deficit
                uint256 deficit = debt - wethBal;
                
                uint256 usdcBal = IERC20(usdc).balanceOf(address(this));
                if (usdcBal > 0) {
                    IERC20(usdc).forceApprove(address(swapRouter), usdcBal); 
                    
                    // Calculate max input (Slippage protection)
                    // We expect to pay `deficit` in WETH value.
                    // usdcCost = deficit * price
                    uint256 expectedUsdcCost = _convertWethToUsdc(deficit);
                    // Allow some slippage
                    uint256 maxUsdcIn = (expectedUsdcCost * (10000 + SLIPPAGE_BPS)) / 10000;
                    
                    // Cap at balance
                    if (maxUsdcIn > usdcBal) maxUsdcIn = usdcBal;

                    // Use exactOutputSingle to buy ONLY needed WETH
                    ISwapRouter.ExactOutputSingleParams memory swapParams = ISwapRouter.ExactOutputSingleParams({
                        tokenIn: usdc,
                        tokenOut: weth,
                        fee: 500,
                        recipient: address(this),
                        amountOut: deficit, 
                        amountInMaximum: maxUsdcIn,
                        sqrtPriceLimitX96: 0
                    });
                    
                    try swapRouter.exactOutputSingle(swapParams) {
                        // swap success
                    } catch {
                        // swap failed, proceed with partial repay
                    }
                }
            }
            
            // Refresh balance
            wethBal = IERC20(weth).balanceOf(address(this));
            IERC20(weth).forceApprove(address(collateralManager), wethBal);
            
            // Re-check debt in case it changed? No.
            uint256 repayAmount = wethBal > debt ? debt : wethBal;
            
            if (repayAmount > 0) {
                CollateralManager.RepayParams memory rParams = CollateralManager.RepayParams({
                    collateralAsset: usdc,
                    collateralPct1e5: 100_000,
                    debtAsset: weth,
                    amount: repayAmount,
                    interestRateMode: 2
                });
                collateralManager.repayDebt(rParams); 
            }
            
            // Check for excess WETH and swap back to USDC
            wethBal = IERC20(weth).balanceOf(address(this));
            if (wethBal > 0) {
                IERC20(weth).forceApprove(address(swapRouter), wethBal);
                
                // Calculate min out
                uint256 expectedUsdc = _convertWethToUsdc(wethBal);
                uint256 minUsdc = (expectedUsdc * (10000 - SLIPPAGE_BPS)) / 10000;

                ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
                    tokenIn: weth,
                    tokenOut: usdc,
                    fee: 500,
                    recipient: address(this),
                    amountIn: wethBal,
                    amountOutMinimum: minUsdc,
                    sqrtPriceLimitX96: 0
                });
                try swapRouter.exactInputSingle(swapParams) {} catch {}
            }
        }
    }

    function _claimToVault() internal {
        _harvest(vault);
    }

    // --- Helpers ---

    function _getEthPriceInUsdc() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        return _getPriceFromSqrtX96(sqrtPriceX96);
    }

    function _calculateWethFromUsdc(uint256 usdcAmount) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 numerator = usdcAmount * (1 << 192);
        uint256 wethRaw = numerator / priceX96;
        return wethRaw;
    }
    
    function _convertWethToUsdc(uint256 wethAmount) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        return (wethAmount * priceX96) >> 192;
    }

    function _getPriceFromSqrtX96(uint160 /*sqrtPriceX96*/) internal pure returns (uint256) {
        return 0; // Placeholder
    }
}
