// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.6;

import "../base/Utils.sol";
import "../base/BaseModule.sol";
import "./IGuardianManager.sol";

/**
 * @title GuardianManager
 * @notice Module to manage the guardians of wallets.
 * Guardians are accounts (EOA or contracts) that are authorized to perform specific security operations on wallet
 * such as toggle a safety lock, start a recovery procedure, or confirm transactions.
 * Addition or revokation of guardians is initiated by the owner of a wallet and must be confirmed after a security period (e.g. 24 hours).
 * The list of guardians for a wallet is stored on a separate contract to facilitate its use by other modules.
 * @author Julien Niset - <julien@argent.xyz>
 * @author Olivier Van Den Biggelaar - <olivier@argent.xyz>
 */
contract GuardianManager is IGuardianManager, BaseModule {
    bytes4 constant internal CONFIRM_ADDITION_PREFIX = bytes4(keccak256("confirmGuardianAddition(address,address)"));
    bytes4 constant internal CONFIRM_REVOKATION_PREFIX = bytes4(keccak256("confirmGuardianRevokation(address,address)")); 

    /**
    * @inheritdoc IGuardianManager
    */
    function addGuardian(address _guardian) external override
    onlyWalletOwner()
    onlyWhenUnlocked()
    {
        require(owner != _guardian, "GM: target guardian cannot be owner");
        require(!isGuardian(_guardian), "GM: target is already a guardian");
        // Guardians must either be an EOA or a contract with an owner()
        // method that returns an address with a 5000 gas stipend.
        // Note that this test is not meant to be strict and can be bypassed by custom malicious contracts.
        (bool success,) = _guardian.call{gas: 5000}(abi.encodeWithSignature("owner()"));
        require(success, "GM: guardian must be EOA or implement owner()");
        uint256 _securityPeriod = Configuration(registry).securityPeriod();

        if (guardianCount() == 0) {
            _addGuardian(_guardian);
            emit GuardianAdded(address(this), _guardian);
        } else {
            bytes32 id = keccak256(abi.encodePacked(_guardian, "addition"));
            require(
                pending[id] == 0 || block.timestamp > pending[id] + Configuration(registry).securityWindow(),
                "GM: addition of target as guardian is already pending");
            pending[id] = block.timestamp + _securityPeriod;
            emit GuardianAdditionRequested(address(this), _guardian, block.timestamp + _securityPeriod);
        }
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function confirmGuardianAddition(address _guardian) external override onlyWhenUnlocked() {
        bytes32 id = keccak256(abi.encodePacked(_guardian, "addition"));

        require(pending[id] > 0, "GM: no pending addition as guardian for target");
        require(pending[id] < block.timestamp, "GM: Too early to confirm guardian addition");
        require(block.timestamp < pending[id] + Configuration(registry).securityWindow(), "GM: Too late to confirm guardian addition");
        _addGuardian(_guardian);
        emit GuardianAdded(address(this), _guardian);
        delete pending[id];
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function cancelGuardianAddition(address _guardian) external override onlyWalletOwner() onlyWhenUnlocked() {
        bytes32 id = keccak256(abi.encodePacked(_guardian, "addition"));

        require(pending[id] > 0, "GM: no pending addition as guardian for target");
        delete pending[id];
        emit GuardianAdditionCancelled(address(this), _guardian);
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function revokeGuardian(address _guardian) external override onlyWalletOwner() {
        require(isGuardian(_guardian), "GM: must be an existing guardian");
        bytes32 id = keccak256(abi.encodePacked(_guardian, "revokation"));

        uint256 _securityPeriod = Configuration(registry).securityPeriod();
        require(
            pending[id] == 0 || block.timestamp > pending[id] + Configuration(registry).securityWindow(),
            "GM: revokation of target as guardian is already pending"); // TODO need to allow if confirmation window passed
        pending[id] = block.timestamp + _securityPeriod;
        emit GuardianRevokationRequested(address(this), _guardian, block.timestamp + _securityPeriod);
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function confirmGuardianRevokation(address _guardian) external override {
        bytes32 id = keccak256(abi.encodePacked(_guardian, "revokation"));

        require(pending[id] > 0, "GM: no pending guardian revokation for target");
        require(pending[id] < block.timestamp, "GM: Too early to confirm guardian revokation");
        require(block.timestamp < pending[id] + Configuration(registry).securityWindow(), "GM: Too late to confirm guardian revokation");

        address lastGuardian = guardians[guardians.length - 1];
        if (_guardian != lastGuardian) {
            uint128 targetIndex = info[_guardian].index;
            guardians[targetIndex] = lastGuardian;
            info[lastGuardian].index = targetIndex;
        }
        guardians.pop();
        delete info[_guardian];

        emit GuardianRevoked(address(this), _guardian);
        delete pending[id];
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function cancelGuardianRevokation(address _guardian) external override
    onlyWalletOwner()
    onlyWhenUnlocked() 
    {
        bytes32 id = keccak256(abi.encodePacked(_guardian, "revokation"));

        require(pending[id] > 0, "GM: no pending guardian revokation for target");
        delete pending[id];
        emit GuardianRevokationCancelled(address(this), _guardian);
    }

    /**
    * @inheritdoc IGuardianManager
    */
    function getGuardians() public view override returns (address[] memory) {
        address[] memory guardians = new address[](guardians.length);
        for (uint256 i = 0; i < guardians.length; i++) {
            guardians[i] = guardians[i];
        }
        return guardians;
    }

    /**
    * @dev Checks if an address is the owner of a guardian contract.
    * The method does not revert if the call to the owner() method consumes more then 5000 gas.
    * @param _guardian The guardian contract
    * @param _owner The owner to verify.
    */
    function isGuardianOwner(address _guardian, address _owner) internal view returns (bool) {
        address owner = address(0);
        bytes4 sig = bytes4(keccak256("owner()"));
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr,sig)
            let result := staticcall(5000, _guardian, ptr, 0x20, ptr, 0x20)
            if eq(result, 1) {
                owner := mload(ptr)
            }
        }
        return owner == _owner;
    }

    /**
    * @notice Checks if an address is a guardian or an account authorised to sign on behalf of a smart-contract guardian.
    * @param _guardian the address to test
    * @return _isGuardian `true` if the address is a guardian for the wallet otherwise `false`.
    */
    function isGuardianOrGuardianSigner(address _guardian) external view returns (bool _isGuardian) {
        (_isGuardian, ) = isGuardianOrGuardianSigner(getGuardians(), _guardian);
    }

        /**
    * @notice Checks if an address is a guardian or an account authorised to sign on behalf of a smart-contract guardian
    * given a list of guardians.
    * @param _guardians the list of guardians
    * @param _guardian the address to test
    * @return true and the list of guardians minus the found guardian upon success, false and the original list of guardians if not found.
    */
    function isGuardianOrGuardianSigner(address[] memory _guardians, address _guardian) private view returns (bool, address[] memory) {
        if (_guardians.length == 0 || _guardian == address(0)) {
            return (false, _guardians);
        }
        bool isFound = false;
        address[] memory updatedGuardians = new address[](_guardians.length - 1);
        uint256 index = 0;
        for (uint256 i = 0; i < _guardians.length; i++) {
            if (!isFound) {
                // check if _guardian is an account guardian
                if (_guardian == _guardians[i]) {
                    isFound = true;
                    continue;
                }
                // check if _guardian is the owner of a smart contract guardian
                if (Utils.isContract(_guardians[i]) && isGuardianOwner(_guardians[i], _guardian)) {
                    isFound = true;
                    continue;
                }
            }
            if (index < updatedGuardians.length) {
                updatedGuardians[index] = _guardians[i];
                index++;
            }
        }
        return isFound ? (true, updatedGuardians) : (false, _guardians);
    }

    function _addGuardian(address _guardian) private {
        GuardianInfo storage guardianInfo = info[_guardian];
        guardianInfo.exists = true;
        guardians.push(_guardian);
        guardianInfo.index = uint128(guardians.length - 1);
    }
}