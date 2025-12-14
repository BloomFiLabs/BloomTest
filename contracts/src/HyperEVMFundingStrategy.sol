// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./HyperEVMInterfaces.sol";
import "./IStrategy.sol";

contract HyperEVMFundingStrategy is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    // Constants
    address public constant L1_READ = 0x0000000000000000000000000000000000000800;
    address public constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    uint256 public constant SCALE_1E8 = 1e8;
    uint256 public constant SCALE_1E6 = 1e6; // USDC usually 6 decimals

    // Config
    IERC20 public immutable usdc;
    address public immutable vault;
    uint32 public immutable assetId; // HyperLiquid Asset ID (e.g. ETH = ?)

    // State
    mapping(address => bool) public keepers;
    uint256 public totalPrincipal;
    
    event KeeperUpdated(address indexed keeper, bool active);
    event Rebalanced(int256 targetDelta, uint256 timestamp);
    event EmergencyExit(uint256 assetsRecovered);

    modifier onlyVault() {
        require(msg.sender == vault, "Only Vault");
        _;
    }

    modifier onlyKeeper() {
        require(keepers[msg.sender] || msg.sender == owner(), "Only Keeper or Owner");
        _;
    }

    constructor(
        address _vault,
        address _usdc,
        uint32 _assetId
    ) Ownable(msg.sender) {
        vault = _vault;
        usdc = IERC20(_usdc);
        assetId = _assetId;
    }

    function setKeeper(address keeper, bool active) external onlyOwner {
        keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }

    // --- Core Strategy Functions ---

    function deposit(uint256 amount) external override onlyVault {
        require(amount > 0, "Amount > 0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;

        // Move funds from Spot (EVM Balance) to Perp (Margin)
        // Assumption: Holding USDC on EVM is equivalent to Spot Balance
        // Action 7: USD Class Transfer (ntl, toPerp)
        _sendUsdClassTransfer(amount, true);
    }

    function withdraw(uint256 amount) external override onlyVault {
        // 1. Move funds from Perp to Spot
        // We might need to reduce position first? 
        // For now, assume we have enough free collateral or this is a partial withdraw.
        // If amount > free margin, this might fail on HyperCore.
        
        // Action 7: USD Class Transfer (ntl, toPerp=false)
        _sendUsdClassTransfer(amount, false);

        // 2. Transfer to Vault
        usdc.safeTransfer(vault, amount);
        
        if (totalPrincipal >= amount) {
            totalPrincipal -= amount;
        } else {
            totalPrincipal = 0;
        }
    }

    function claimRewards(address recipient) external override returns (uint256) {
        // Harvest logic: Check Vault Equity vs Principal
        // If Equity > Principal, withdraw difference
        uint256 equity = _getVaultEquity();
        
        // This is a simplified view. Real PnL logic might be more complex.
        if (equity > totalPrincipal) {
            uint256 profit = equity - totalPrincipal;
            if (profit > 0) {
                // Move profit from Perp to Spot
                _sendUsdClassTransfer(profit, false);
                
                // Send to recipient
                usdc.safeTransfer(recipient, profit);
                return profit;
            }
        }
        return 0;
    }

    function totalAssets() external view override returns (uint256) {
        // Total Assets = Vault Equity (Margin + PnL) + Spot Balance (Idle USDC)
        return _getVaultEquity() + usdc.balanceOf(address(this));
    }

    // --- Keeper Functions ---

    /// @notice Execute rebalance based on off-chain funding calculation
    /// @param isLong Whether to be long or short
    /// @param priceLimit Limit price for the order (1e8 scaled)
    /// @param size Size of the position (1e8 scaled units)
    /// @param reduceOnly Whether this is a reduce-only order
    function rebalance(
        bool isLong,
        uint64 priceLimit,
        uint64 size,
        bool reduceOnly
    ) external onlyKeeper {
        // Action 1: Limit Order
        // (asset, isBuy, limitPx, sz, reduceOnly, encodedTif, cloid)
        
        // TIF: 2 (GTC) or 3 (IOC). Let's use IOC (3) for rebalancing to avoid stuck orders.
        uint8 tif = 3; 
        uint128 cloid = 0; // No client order ID for now

        bytes memory encodedAction = abi.encode(
            assetId,
            isLong,
            priceLimit,
            size,
            reduceOnly,
            tif,
            cloid
        );

        _sendAction(1, encodedAction);
        
        // TODO: Could verify fill via L1Read?
        emit Rebalanced(isLong ? int256(uint256(size)) : -int256(uint256(size)), block.timestamp);
    }
    
    /// @notice Updates leverage by depositing/withdrawing margin
    /// @dev Action 2: Vault Transfer (vault, isDeposit, usd)
    /// NOTE: This action is for SUB-VAULTS. For main account, use Action 7 (USD Class Transfer).
    /// Kept here if we need to manage sub-vaults later.
    function updateMargin(uint64 amount, bool isDeposit) external onlyKeeper {
         // Logic for Action 2 if needed
    }

    function emergencyExit() external onlyKeeper {
        // Close all positions
        // 1. Read current position size
        IL1Read.PerpsPosition[] memory positions = IL1Read(L1_READ).readPerpPositions(address(this));
        
        for(uint i=0; i < positions.length; i++) {
            if (positions[i].coin == assetId && positions[i].szi != 0) {
                bool isLong = positions[i].szi > 0;
                uint64 size = uint64(uint256(isLong ? positions[i].szi : -positions[i].szi)); // abs value
                
                // Place reduce-only market order to close
                // Limit price: aggressive to ensure fill
                uint64 limitPx = isLong ? 0 : type(uint64).max; // Sell at 0 or Buy at Max
                
                bytes memory encodedAction = abi.encode(
                    assetId,
                    !isLong, // Close: Sell if Long, Buy if Short
                    limitPx,
                    size,
                    true, // reduceOnly
                    3, // IOC
                    uint128(0)
                );
                _sendAction(1, encodedAction);
            }
        }
        
        // Withdraw all margin to Spot
        uint256 equity = _getVaultEquity();
        if (equity > 0) {
            _sendUsdClassTransfer(equity, false); // Perp -> Spot
        }
        
        emit EmergencyExit(equity);
    }

    // --- Internal Helpers ---

    function _sendUsdClassTransfer(uint256 amount, bool toPerp) internal {
        // Action 7: (uint64 ntl, bool toPerp)
        // Amount needs to be cast to uint64 (HyperLiquid uses 6 decimals for USD, usually fits in u64)
        // Ensure amount fits
        require(amount <= type(uint64).max, "Amount overflow");
        
        bytes memory encodedAction = abi.encode(uint64(amount), toPerp);
        _sendAction(7, encodedAction);
    }

    function _sendAction(uint8 actionId, bytes memory encodedPayload) internal {
        // Action encoding details:
        // Byte 1: Version (1)
        // Bytes 2-4: Action ID (Big Endian)
        // Remaining: Payload
        
        bytes memory data = new bytes(4 + encodedPayload.length);
        data[0] = 0x01;
        data[1] = 0x00; // ID High
        data[2] = 0x00; // ID Mid
        data[3] = bytes1(actionId); // ID Low
        
        for (uint256 i = 0; i < encodedPayload.length; i++) {
            data[4 + i] = encodedPayload[i];
        }
        
        ICoreWriter(CORE_WRITER).sendRawAction(data);
    }

    function _getVaultEquity() internal view returns (uint256) {
        return IL1Read(L1_READ).readVaultEquity(address(this));
    }
}

