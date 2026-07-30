// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The deployable token variants, one per tier in `src/catalogue.ts`. Compiled by
// `scripts/compile-contracts.mjs` into `src/contracts/generated.ts`, which is COMMITTED: the
// service runs under tsx with no build step to hang a compile on, and bytecode in git is bytecode
// a reviewer can diff. CI recompiles and fails on any difference, so the committed artefact and
// the source below cannot drift.
//
// CARRIED FORWARD UNCHANGED from `forge-mint/contracts/ForgeTokens.sol`. It is one of the things
// the frozen service gets right and the most important of them: `owner_` / `recipient_` is the
// CUSTOMER'S OWN WALLET. The platform's deployer address appears nowhere in this file — it pays
// the gas for the creation and receives nothing, holds nothing and can do nothing afterwards.
// Custody enforces the other half: a `deployer`-purpose address may only ever sign a zero-value
// contract creation, so even holding a signing credential nobody can make it transfer or mint.
//
// Every variant takes `decimals_` as a constructor argument rather than hardcoding 18 — the order
// form lets a customer pick 0-18 and the token must actually report it.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Spark tier: fixed supply, no privileged roles. Nothing can ever mint again.
contract FixedSupplyToken is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
        _mint(recipient_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }
}

/// Forge tier: ownable, mintable and burnable. Supply is uncapped by design.
contract MintableToken is ERC20, ERC20Burnable, Ownable {
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        _customDecimals = decimals_;
        _mint(owner_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// Foundry tier: ownable, mintable, burnable, pausable and hard-capped.
contract FoundryToken is ERC20, ERC20Burnable, ERC20Capped, ERC20Pausable, Ownable {
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        uint256 cap_,
        address owner_
    ) ERC20(name_, symbol_) ERC20Capped(cap_) Ownable(owner_) {
        _customDecimals = decimals_;
        _mint(owner_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Capped, ERC20Pausable) {
        super._update(from, to, value);
    }
}
