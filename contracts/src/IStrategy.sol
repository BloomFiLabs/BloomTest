// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategy {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function claimRewards(address recipient) external returns (uint256);
    function totalAssets() external view returns (uint256);
}










