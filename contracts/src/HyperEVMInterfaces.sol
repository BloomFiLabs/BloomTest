// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HyperEVM Interfaces
/// @notice Interfaces for interacting with HyperCore from HyperEVM

interface IL1Read {
    struct PerpsPosition {
        uint256 coin; // Asset ID
        int256 szi; // Size (in contract units? or scaled?)
        int256 entryPx;
        int256 positionValue;
        int256 unrealizedPnl;
        int256 liquidationPx;
        int256 marginUsed;
        int256 maxLeverage;
        int256 cumFunding;
    }

    struct SpotBalance {
        uint256 coin;
        uint256 balance;
        int256 entryPx;
    }

    // Based on description: "perps positions, spot balances, vault equity, staking delegations, oracle prices"
    // Signatures are inferred from typical Hyperliquid API responses but adapted to Solidity return types.
    // Note: Actual signatures might differ slightly in production.

    function readPerpPositions(address user) external view returns (PerpsPosition[] memory);
    function readSpotBalances(address user) external view returns (SpotBalance[] memory);
    function readVaultEquity(address user) external view returns (uint256 equity);
    function readOraclePrices(uint256[] calldata assets) external view returns (uint256[] memory prices);
    function readL1BlockNumber() external view returns (uint64);
}

interface ICoreWriter {
    // Sends a raw action to HyperCore. 
    // Data encoding: Version (1 byte) + ActionID (3 bytes) + ABI encoded payload
    function sendRawAction(bytes calldata action) external;
}



