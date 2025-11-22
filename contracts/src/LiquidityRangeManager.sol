// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import {sqrt as prbSqrt, mulDiv as prbMulDiv} from "@prb/math/Common.sol";

contract LiquidityRangeManager {
    uint256 public constant RANGE_PERCENT_SCALE = 1e5; // 0.00001% precision
    uint256 public constant MIN_RANGE_PERCENT = 1; // 0.00001%
    uint256 public constant MAX_RANGE_PERCENT = 9_999_000; // 99.99%
    uint256 private constant ONE_WAD = 1e18;

    INonfungiblePositionManagerLike public immutable positionManager;

    struct ManageLiquidityParams {
        address pool;
        uint256 rangePct1e5;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        address pool;
        uint256 rangePct1e5;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct ManagedPosition {
        uint256 tokenId;
        uint128 liquidity;
        address pool;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(bytes32 => ManagedPosition) private managedPositions;
    mapping(uint256 => address) public positionOwner;

    event PositionOpened(address indexed owner, address indexed pool, uint256 rangePct1e5, uint256 indexed tokenId);
    event LiquidityChanged(address indexed owner, uint256 indexed tokenId, uint128 liquidityDelta, bool increase);
    event PositionClosed(address indexed owner, uint256 indexed tokenId);
    event FeesCollected(address indexed owner, uint256 indexed tokenId, uint256 amount0, uint256 amount1);

    constructor(address _positionManager) {
        require(_positionManager != address(0), "position manager required");
        positionManager = INonfungiblePositionManagerLike(_positionManager);
    }

    function increaseLiquidity(ManageLiquidityParams calldata params)
        external
        returns (uint256 tokenId, uint128 liquidityAdded, uint256 amount0, uint256 amount1)
    {
        _validateDeadline(params.deadline);
        _validateRange(params.rangePct1e5);

        bytes32 key = _positionKey(msg.sender, params.pool, params.rangePct1e5);
        ManagedPosition storage position = managedPositions[key];

        PoolData memory poolData = _getPoolData(params.pool);

        _pullAndApprove(poolData.token0, params.amount0Desired);
        _pullAndApprove(poolData.token1, params.amount1Desired);

        if (position.tokenId == 0) {
            (int24 tickLower, int24 tickUpper) = _calculateRangeTicks(params.pool, params.rangePct1e5);

            INonfungiblePositionManagerLike.MintParams memory mintParams = INonfungiblePositionManagerLike.MintParams({
                token0: poolData.token0,
                token1: poolData.token1,
                fee: poolData.fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: params.amount0Desired,
                amount1Desired: params.amount1Desired,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                recipient: address(this),
                deadline: params.deadline
            });

            (tokenId, liquidityAdded, amount0, amount1) = positionManager.mint(mintParams);

            position.tokenId = tokenId;
            position.pool = params.pool;
            position.tickLower = tickLower;
            position.tickUpper = tickUpper;
            position.liquidity = liquidityAdded;
            positionOwner[tokenId] = msg.sender;

            emit PositionOpened(msg.sender, params.pool, params.rangePct1e5, tokenId);
        } else {
            require(positionOwner[position.tokenId] == msg.sender, "NOT_OWNER");
            tokenId = position.tokenId;

            INonfungiblePositionManagerLike.IncreaseLiquidityParams memory increaseParams =
                INonfungiblePositionManagerLike.IncreaseLiquidityParams({
                    tokenId: tokenId,
                    amount0Desired: params.amount0Desired,
                    amount1Desired: params.amount1Desired,
                    amount0Min: params.amount0Min,
                    amount1Min: params.amount1Min,
                    deadline: params.deadline
                });

            (liquidityAdded, amount0, amount1) = positionManager.increaseLiquidity(increaseParams);
            position.liquidity += liquidityAdded;
        }

        _revokeApproval(poolData.token0);
        _revokeApproval(poolData.token1);

        _refundExcess(poolData.token0, params.amount0Desired, amount0);
        _refundExcess(poolData.token1, params.amount1Desired, amount1);

        emit LiquidityChanged(msg.sender, position.tokenId, liquidityAdded, true);
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        _validateDeadline(params.deadline);

        bytes32 key = _positionKey(msg.sender, params.pool, params.rangePct1e5);
        ManagedPosition storage position = managedPositions[key];
        require(position.tokenId != 0, "POSITION_NOT_FOUND");
        require(positionOwner[position.tokenId] == msg.sender, "NOT_OWNER");
        require(params.liquidity > 0 && params.liquidity <= position.liquidity, "INVALID_LIQ");

        INonfungiblePositionManagerLike.DecreaseLiquidityParams memory decreaseParams =
            INonfungiblePositionManagerLike.DecreaseLiquidityParams({
                tokenId: position.tokenId,
                liquidity: params.liquidity,
                amount0Min: params.amount0Min,
                amount1Min: params.amount1Min,
                deadline: params.deadline
            });

        positionManager.decreaseLiquidity(decreaseParams);

        INonfungiblePositionManagerLike.CollectParams memory collectParams =
            INonfungiblePositionManagerLike.CollectParams({
                tokenId: position.tokenId,
                recipient: msg.sender,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (amount0, amount1) = positionManager.collect(collectParams);

        position.liquidity -= params.liquidity;
        emit LiquidityChanged(msg.sender, position.tokenId, params.liquidity, false);

        if (position.liquidity == 0) {
            positionManager.burn(position.tokenId);
            delete positionOwner[position.tokenId];
            delete managedPositions[key];
            emit PositionClosed(msg.sender, position.tokenId);
        }
    }

    function collectFees(address pool, uint256 rangePct1e5, address recipient) 
        external 
        returns (uint256 amount0, uint256 amount1) 
    {
        bytes32 key = _positionKey(msg.sender, pool, rangePct1e5);
        ManagedPosition memory position = managedPositions[key];
        require(position.tokenId != 0, "POSITION_NOT_FOUND");
        require(positionOwner[position.tokenId] == msg.sender, "NOT_OWNER");

        INonfungiblePositionManagerLike.CollectParams memory collectParams =
            INonfungiblePositionManagerLike.CollectParams({
                tokenId: position.tokenId,
                recipient: recipient == address(0) ? msg.sender : recipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (amount0, amount1) = positionManager.collect(collectParams);
        emit FeesCollected(msg.sender, position.tokenId, amount0, amount1);
    }

    function getManagedPosition(address owner, address pool, uint256 rangePct1e5)
        external
        view
        returns (uint256 tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)
    {
        bytes32 key = _positionKey(owner, pool, rangePct1e5);
        ManagedPosition memory position = managedPositions[key];
        tokenId = position.tokenId;
        liquidity = position.liquidity;
        tickLower = position.tickLower;
        tickUpper = position.tickUpper;
    }

    struct PoolData {
        address token0;
        address token1;
        uint24 fee;
    }

    function _getPoolData(address pool) internal view returns (PoolData memory data) {
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        data.token0 = uniPool.token0();
        data.token1 = uniPool.token1();
        data.fee = uniPool.fee();
    }

    function calculateRangeTicks(address pool, uint256 rangePct1e5)
        external
        view
        returns (int24 tickLower, int24 tickUpper) 
    {
        return _calculateRangeTicks(pool, rangePct1e5);
    }

    function _calculateRangeTicks(address pool, uint256 rangePct1e5)
        internal
        view
        returns (int24 tickLower, int24 tickUpper)
    {
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        (uint160 sqrtPriceX96, , , , , , ) = uniPool.slot0();
        int24 spacing = uniPool.tickSpacing();

        // rangePct1e5 is in 1e5 scale. 1e5 = 100%.
        // percentFraction = rangePct1e5 / 100 / 1e5 * 1e18 = rangePct1e5 * 1e11?
        // Old: (rangePct1e5 * ONE_WAD) / (100 * RANGE_PERCENT_SCALE);
        // 50000 * 1e18 / 1e7 = 5e15. Correct (0.005 * 1e18).
        uint256 percentFraction = (rangePct1e5 * ONE_WAD) / (100 * RANGE_PERCENT_SCALE);
        
        // upperFactor = sqrt(1e18 + 5e15) = sqrt(1.005e18) = 1.00249 * 1e9.
        uint256 upperFactor = prbSqrt(ONE_WAD + percentFraction);
        uint256 lowerFactor = prbSqrt(ONE_WAD - percentFraction);

        // We want upperSqrt = sqrtPriceX96 * upperFactor / 1e9.
        // Because upperFactor is scaled by 1e9.
        uint160 upperSqrt = uint160(prbMulDiv(uint256(sqrtPriceX96), upperFactor, 1e9));
        uint160 lowerSqrt = uint160(prbMulDiv(uint256(sqrtPriceX96), lowerFactor, 1e9));

        tickUpper = TickMath.getTickAtSqrtRatio(upperSqrt);
        tickLower = TickMath.getTickAtSqrtRatio(lowerSqrt);

        tickLower = _floorTick(tickLower, spacing);
        tickUpper = _ceilTick(tickUpper, spacing);

        if (tickUpper <= tickLower) {
            tickUpper = tickLower + spacing;
        }
    }

    function _pullAndApprove(address token, uint256 amount) internal {
        if (amount == 0) return;
        TransferHelper.safeTransferFrom(token, msg.sender, address(this), amount);
        TransferHelper.safeApprove(token, address(positionManager), 0);
        TransferHelper.safeApprove(token, address(positionManager), amount);
    }

    function _revokeApproval(address token) internal {
        TransferHelper.safeApprove(token, address(positionManager), 0);
    }

    function _refundExcess(address token, uint256 desired, uint256 used) internal {
        if (desired > used) {
            uint256 refund = desired - used;
            TransferHelper.safeTransfer(token, msg.sender, refund);
        }
    }

    function _validateRange(uint256 rangePct1e5) internal pure {
        require(rangePct1e5 >= MIN_RANGE_PERCENT, "RANGE_TOO_SMALL");
        require(rangePct1e5 <= MAX_RANGE_PERCENT, "RANGE_TOO_LARGE");
    }

    function _validateDeadline(uint256 deadline) internal view {
        require(deadline >= block.timestamp, "DEADLINE_PASSED");
    }

    function _positionKey(address owner, address pool, uint256 rangePct1e5) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, pool, rangePct1e5));
    }

    function _floorTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 remainder = tick % spacing;
        if (remainder == 0) return tick;
        if (tick < 0) {
            return tick - remainder - spacing;
        }
        return tick - remainder;
    }

    function _ceilTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 remainder = tick % spacing;
        if (remainder == 0) return tick;
        if (tick < 0) {
            return tick - remainder;
        }
        return tick + (spacing - remainder);
    }

    function getPositionAmounts(address owner, address pool, uint256 rangePct1e5) 
        external view returns (uint256 amount0, uint256 amount1) 
    {
        bytes32 key = _positionKey(owner, pool, rangePct1e5);
        ManagedPosition memory position = managedPositions[key];
        
        if (position.liquidity == 0) return (0, 0);
        
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(position.tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(position.tickUpper);

        if (sqrtPriceX96 <= sqrtRatioAX96) {
            amount0 = _getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, position.liquidity);
        } else if (sqrtPriceX96 < sqrtRatioBX96) {
            amount0 = _getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, position.liquidity);
            amount1 = _getAmount1ForLiquidity(sqrtRatioAX96, sqrtPriceX96, position.liquidity);
        } else {
            amount1 = _getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, position.liquidity);
        }
    }

    function _getAmount0ForLiquidity(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint128 liquidity) internal pure returns (uint256 amount0) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
        uint256 temp = prbMulDiv(numerator1, numerator2, sqrtRatioBX96);
        amount0 = temp / sqrtRatioAX96;
    }

    function _getAmount1ForLiquidity(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint128 liquidity) internal pure returns (uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        amount1 = prbMulDiv(uint256(liquidity), sqrtRatioBX96 - sqrtRatioAX96, 1 << 96);
    }
}

interface INonfungiblePositionManagerLike {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external;
}
