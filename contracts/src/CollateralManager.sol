// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@aave/v3-core/contracts/interfaces/IPool.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CollateralManager {
    using SafeERC20 for IERC20;

    uint256 public constant COLLATERAL_PERCENT_SCALE = 1e5; // 0.00001% precision
    uint256 public constant MIN_COLLATERAL_PERCENT = 1; // 0.00001%
    uint256 public constant MAX_COLLATERAL_PERCENT = 10_000_000; // 100%

    IPool public immutable pool;

    struct ManageCollateralParams {
        address asset;
        uint256 collateralPct1e5;
        uint256 amountDesired;
        uint256 amountMin;
        uint16 referralCode;
    }

    struct DecreaseCollateralParams {
        address asset;
        uint256 collateralPct1e5;
        uint256 amount;
        uint256 amountMin;
    }

    struct BorrowParams {
        address collateralAsset;
        uint256 collateralPct1e5;
        address debtAsset;
        uint256 amount;
        uint256 interestRateMode; // 1 = stable, 2 = variable
        uint16 referralCode;
        address recipient;
    }

    struct RepayParams {
        address collateralAsset;
        uint256 collateralPct1e5;
        address debtAsset;
        uint256 amount;
        uint256 interestRateMode;
    }

    struct ManagedCollateral {
        address asset;
        uint256 amount;
    }

    mapping(bytes32 => ManagedCollateral) private managedCollaterals;
    mapping(bytes32 => mapping(address => mapping(uint256 => uint256))) private managedDebts;

    event CollateralIncreased(
        address indexed owner,
        address indexed asset,
        uint256 collateralPct1e5,
        uint256 amount
    );
    event CollateralDecreased(
        address indexed owner,
        address indexed asset,
        uint256 collateralPct1e5,
        uint256 amount
    );
    event LiquidityBorrowed(
        address indexed owner,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralPct1e5,
        uint256 amount,
        uint256 interestRateMode
    );
    event DebtRepaid(
        address indexed owner,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralPct1e5,
        uint256 amount,
        uint256 interestRateMode
    );

    constructor(address _pool) {
        require(_pool != address(0), "POOL_REQUIRED");
        pool = IPool(_pool);
    }

    function depositCollateral(ManageCollateralParams calldata params) external returns (uint256 amountSupplied) {
        _validatePercent(params.collateralPct1e5);
        require(params.amountDesired > 0, "ZERO_AMOUNT");

        bytes32 key = _positionKey(msg.sender, params.asset, params.collateralPct1e5);
        ManagedCollateral storage position = managedCollaterals[key];

        if (position.asset == address(0)) {
            position.asset = params.asset;
        } else {
            require(position.asset == params.asset, "ASSET_MISMATCH");
        }

        IERC20 collateralToken = IERC20(params.asset);
        collateralToken.safeTransferFrom(msg.sender, address(this), params.amountDesired);
        collateralToken.forceApprove(address(pool), 0);
        collateralToken.forceApprove(address(pool), params.amountDesired);

        pool.supply(params.asset, params.amountDesired, address(this), params.referralCode);

        collateralToken.forceApprove(address(pool), 0);

        amountSupplied = params.amountDesired;
        require(amountSupplied >= params.amountMin, "MIN_AMOUNT");

        position.amount += amountSupplied;

        emit CollateralIncreased(msg.sender, params.asset, params.collateralPct1e5, amountSupplied);
    }

    function withdrawCollateral(DecreaseCollateralParams calldata params)
        external
        returns (uint256 amountWithdrawn)
    {
        _validatePercent(params.collateralPct1e5);
        require(params.amount > 0, "ZERO_AMOUNT");

        bytes32 key = _positionKey(msg.sender, params.asset, params.collateralPct1e5);
        ManagedCollateral storage position = managedCollaterals[key];
        require(position.asset != address(0), "POSITION_NOT_FOUND");
        
        // If requesting MAX, we cap at tracked amount
        uint256 amountToWithdraw = params.amount;
        if (amountToWithdraw == type(uint256).max) {
            amountToWithdraw = position.amount;
        } else {
            require(position.amount >= amountToWithdraw, "INSUFFICIENT_COLLATERAL");
        }

        IERC20 collateralToken = IERC20(params.asset);

        // Aave might burn aToken, but we need underlying.
        // If we ask Aave to withdraw MAX, it withdraws everything available.
        // We should ask Aave for `amountToWithdraw` or MAX if we want all.
        uint256 aaveWithdrawAmount = params.amount == type(uint256).max ? type(uint256).max : amountToWithdraw;

        amountWithdrawn = pool.withdraw(params.asset, aaveWithdrawAmount, address(this));
        require(amountWithdrawn >= params.amountMin, "MIN_AMOUNT");

        if (position.amount >= amountWithdrawn) {
            position.amount -= amountWithdrawn;
        } else {
            position.amount = 0;
        }
        
        collateralToken.safeTransfer(msg.sender, amountWithdrawn);

        emit CollateralDecreased(msg.sender, params.asset, params.collateralPct1e5, amountWithdrawn);

        if (position.amount == 0) {
            delete managedCollaterals[key];
        }
    }

    function borrowLiquidity(BorrowParams calldata params) external returns (uint256 amountBorrowed) {
        _validatePercent(params.collateralPct1e5);
        require(params.amount > 0, "ZERO_AMOUNT");

        bytes32 key = _positionKey(msg.sender, params.collateralAsset, params.collateralPct1e5);
        ManagedCollateral storage position = managedCollaterals[key];
        require(position.amount > 0, "NO_COLLATERAL");

        pool.borrow(
            params.debtAsset,
            params.amount,
            params.interestRateMode,
            params.referralCode,
            address(this)
        );

        managedDebts[key][params.debtAsset][params.interestRateMode] += params.amount;

        address recipient = params.recipient == address(0) ? msg.sender : params.recipient;
        IERC20 debtToken = IERC20(params.debtAsset);
        debtToken.safeTransfer(recipient, params.amount);

        emit LiquidityBorrowed(
            msg.sender,
            params.collateralAsset,
            params.debtAsset,
            params.collateralPct1e5,
            params.amount,
            params.interestRateMode
        );

        return params.amount;
    }

    function repayDebt(RepayParams calldata params) external returns (uint256 amountRepaid) {
        _validatePercent(params.collateralPct1e5);
        require(params.amount > 0, "ZERO_AMOUNT");

        bytes32 key = _positionKey(msg.sender, params.collateralAsset, params.collateralPct1e5);
        uint256 outstanding = managedDebts[key][params.debtAsset][params.interestRateMode];
        require(outstanding >= params.amount, "INSUFFICIENT_DEBT");

        IERC20 debtToken = IERC20(params.debtAsset);
        debtToken.safeTransferFrom(msg.sender, address(this), params.amount);
        debtToken.forceApprove(address(pool), 0);
        debtToken.forceApprove(address(pool), params.amount);

        amountRepaid = pool.repay(
            params.debtAsset,
            params.amount,
            params.interestRateMode,
            address(this)
        );

        debtToken.forceApprove(address(pool), 0);

        managedDebts[key][params.debtAsset][params.interestRateMode] = outstanding - amountRepaid;

        emit DebtRepaid(
            msg.sender,
            params.collateralAsset,
            params.debtAsset,
            params.collateralPct1e5,
            amountRepaid,
            params.interestRateMode
        );
    }

    function getManagedCollateral(address owner, address asset, uint256 collateralPct1e5)
        external
        view
        returns (uint256 amount, address managedAsset)
    {
        bytes32 key = _positionKey(owner, asset, collateralPct1e5);
        ManagedCollateral memory position = managedCollaterals[key];
        amount = position.amount;
        managedAsset = position.asset;
    }

    function getManagedDebt(
        address owner,
        address collateralAsset,
        uint256 collateralPct1e5,
        address debtAsset,
        uint256 interestRateMode
    ) external view returns (uint256) {
        bytes32 key = _positionKey(owner, collateralAsset, collateralPct1e5);
        return managedDebts[key][debtAsset][interestRateMode];
    }

    function _validatePercent(uint256 pct) internal pure {
        require(pct >= MIN_COLLATERAL_PERCENT, "PERCENT_TOO_LOW");
        require(pct <= MAX_COLLATERAL_PERCENT, "PERCENT_TOO_HIGH");
    }

    function _positionKey(address owner, address asset, uint256 pct) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, asset, pct));
    }
}
