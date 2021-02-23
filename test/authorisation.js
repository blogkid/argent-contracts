/* global artifacts */

const ethers = require("ethers");
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

chai.use(bnChai(BN));

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const LockStorage = artifacts.require("LockStorage");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const ArgentModule = artifacts.require("ArgentModule");
const Authoriser = artifacts.require("DappRegistry");
const ERC20 = artifacts.require("TestERC20");
const TestContract = artifacts.require("TestContract");
const Filter = artifacts.require("TestFilter");

const { assert } = require("chai");
const truffleAssert = require("truffle-assertions");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN } = require("../utils/utilities.js");

const ZERO_BYTES32 = ethers.constants.HashZero;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const LOCK_PERIOD = 4;
const RECOVERY_PERIOD = 4;

const CUSTOM_REGISTRY_ID = 12;

const RelayManager = require("../utils/relay-manager");

contract("ArgentModule", (accounts) => {
  let manager;

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const nonwhitelisted = accounts[3];
  const recipient = accounts[4];
  const nonceInitialiser = accounts[4];
  const registryManager = accounts[5];
  const relayer = accounts[9];

  let registry;
  let lockStorage;
  let transferStorage;
  let guardianStorage;
  let module;
  let wallet;
  let walletImplementation;
  let erc20;
  let filter;
  let authoriser;
  let contract;
  let contract2;

  before(async () => {
    registry = await Registry.new();

    lockStorage = await LockStorage.new();
    guardianStorage = await GuardianStorage.new();
    transferStorage = await TransferStorage.new();

    authoriser = await Authoriser.new();

    module = await ArgentModule.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      transferStorage.address,
      authoriser.address,
      SECURITY_PERIOD,
      SECURITY_WINDOW,
      LOCK_PERIOD,
      RECOVERY_PERIOD);

    await registry.registerModule(module.address, ethers.utils.formatBytes32String("ArgentModule"));

    // setup DappRegistry
    contract = await TestContract.new();
    contract2 = await TestContract.new();
    assert.equal(await contract.state(), 0, "initial contract state should be 0");
    assert.equal(await contract2.state(), 0, "initial contract2 state should be 0");
    filter = await Filter.new();
    await authoriser.createRegistry(CUSTOM_REGISTRY_ID, registryManager);
    await authoriser.addAuthorisationToRegistry(0, contract.address, filter.address);
    await authoriser.addAuthorisationToRegistry(CUSTOM_REGISTRY_ID, contract2.address, filter.address, { from: registryManager });
    await authoriser.addAuthorisationToRegistry(0, recipient, ZERO_ADDRESS);
    await authoriser.addAuthorisationToRegistry(0 /* Argent Default Registry */, relayer, ZERO_ADDRESS);

    walletImplementation = await BaseWallet.new();

    manager = new RelayManager(guardianStorage.address, ZERO_ADDRESS);
  });

  async function enableCustomRegistry() {
    assert.equal(await authoriser.isEnabledRegistry(wallet.address, CUSTOM_REGISTRY_ID), false, "custom registry should not be enabled");
    const txReceipt = await manager.relay(
      module,
      "toggleDappRegistry",
      [wallet.address, CUSTOM_REGISTRY_ID, true],
      wallet,
      [owner],
      1,
      ETH_TOKEN,
      relayer);
    const success = await utils.parseRelayReceipt(txReceipt).success;
    assert.isTrue(success, "toggleDappRegistry failed");
    assert.equal(await authoriser.isEnabledRegistry(wallet.address, CUSTOM_REGISTRY_ID), true, "custom registry should be enabled");
    console.log("Gas to call toggleDappRegistry: ", txReceipt.gasUsed);
  }

  async function setupWallet() {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
    await wallet.init(owner, [module.address]);

    const decimals = 12; // number of decimal for TOKN contract

    erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
    await wallet.send(new BN("1000000000000000000"));

    await enableCustomRegistry();
  }

  async function encodeTransaction(to, value, data, isSpenderInData) {
    return { to, value, data, isSpenderInData };
  }

  async function whitelist(target) {
    await module.addToWhitelist(wallet.address, target, { from: owner });
    await utils.increaseTime(3);
    const isTrusted = await module.isWhitelisted(wallet.address, target);
    assert.isTrue(isTrusted, "should be trusted after the security period");
  }

  async function initNonce() {
    // add to whitelist
    await whitelist(nonceInitialiser);
    // set the relayer nonce to > 0
    const transaction = await encodeTransaction(nonceInitialiser, 1, ZERO_BYTES32, false);
    const txReceipt = await manager.relay(
      module,
      "multiCall",
      [wallet.address, [transaction]],
      wallet,
      [owner]);
    const success = await utils.parseRelayReceipt(txReceipt).success;
    assert.isTrue(success, "transfer failed");
  }

  describe("call (un)authorised contract", () => {
    beforeEach(async () => {
      await setupWallet();
      initNonce();
    });

    it("should send ETH to authorised address", async () => {
      const transaction = await encodeTransaction(recipient, 100, ZERO_BYTES32, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        recipient);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "call failed");
      console.log("Gas to send ETH: ", txReceipt.gasUsed);
    });

    it("should call authorised contract when filter passes (argent registry)", async () => {
      const data = contract.contract.methods.setState(4).encodeABI();
      const transaction = await encodeTransaction(contract.address, 0, data, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        recipient);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "call failed");
      assert.equal(await contract.state(), 4, "contract state should be 4");
      console.log("Gas to call contract: ", txReceipt.gasUsed);
    });

    it("should call authorised contract when filter passes (community registry)", async () => {
      const data = contract2.contract.methods.setState(4).encodeABI();
      const transaction = await encodeTransaction(contract2.address, 0, data, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "call failed");
      assert.equal(await contract.state(), 4, "contract state should be 4");
      console.log("Gas to call contract: ", txReceipt.gasUsed);
    });

    it("should block call to authorised contract when filter doesn't pass", async () => {
      const data = contract.contract.methods.setState(5).encodeABI();
      const transaction = await encodeTransaction(contract.address, 0, data, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        relayer);
      const { success, error } = await utils.parseRelayReceipt(txReceipt);
      assert.isFalse(success, "call should have failed");
      assert.equal(error, "TM: call not authorised");
    });

    it("should not send ETH to unauthorised address", async () => {
      const transaction = await encodeTransaction(nonwhitelisted, 100, ZERO_BYTES32, false);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, [transaction]],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        relayer);
      const { success, error } = await utils.parseRelayReceipt(txReceipt);
      assert.isFalse(success, "transfer should have failed");
      assert.equal(error, "TM: call not authorised");
    });
  });

  describe("approve token and call authorised contract", () => {
    beforeEach(async () => {
      await setupWallet();
      await initNonce();
    });

    it("should call authorised contract when filter pass", async () => {
      const transactions = [];

      let data = erc20.contract.methods.approve(contract.address, 100).encodeABI();
      let transaction = await encodeTransaction(erc20.address, 0, data, true);
      transactions.push(transaction);

      data = contract.contract.methods.setStateAndPayToken(4, erc20.address, 100).encodeABI();
      transaction = await encodeTransaction(contract.address, 0, data, false);
      transactions.push(transaction);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, transactions],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        relayer);
      const success = await utils.parseRelayReceipt(txReceipt).success;
      assert.isTrue(success, "call failed");
      assert.equal(await contract.state(), 4, "contract state should be 4");
      console.log("Gas to approve token and call contract: ", txReceipt.gasUsed);
    });

    it("should block call to authorised contract when filter doesn't pass", async () => {
      const transactions = [];

      let data = erc20.contract.methods.approve(contract.address, 100).encodeABI();
      let transaction = await encodeTransaction(erc20.address, 0, data, true);
      transactions.push(transaction);

      data = contract.contract.methods.setStateAndPayToken(5, erc20.address, 100).encodeABI();
      transaction = await encodeTransaction(contract.address, 0, data, false);
      transactions.push(transaction);

      const txReceipt = await manager.relay(
        module,
        "multiCall",
        [wallet.address, transactions],
        wallet,
        [owner],
        10,
        ETH_TOKEN,
        relayer);
      const { success, error } = await utils.parseRelayReceipt(txReceipt);
      assert.isFalse(success, "call should have failed");
      assert.equal(error, "TM: call not authorised");
    });
  });

  describe("enable/disable registry for wallet", () => {
    beforeEach(async () => {
      await setupWallet();
    });
    it("should not enable non-existing registry", async () => {
      const txReceipt = await manager.relay(
        module,
        "toggleDappRegistry",
        [wallet.address, 66, true],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success, error } = await utils.parseRelayReceipt(txReceipt);
      assert.isFalse(success, "toggleDappRegistry should have failed");
      assert.equal(error, "DR: unknow registry");
    });
    it("should not enable already-enabled registry", async () => {
      const txReceipt = await manager.relay(
        module,
        "toggleDappRegistry",
        [wallet.address, CUSTOM_REGISTRY_ID, true],
        wallet,
        [owner],
        1,
        ETH_TOKEN,
        relayer);
      const { success, error } = await utils.parseRelayReceipt(txReceipt);
      assert.isFalse(success, "toggleDappRegistry should have failed");
      assert.equal(error, "DR: bad state change");
    });
  });

  describe("add/remove registry", () => {
    it("should remove a registry", async () => {
      let mgr = await authoriser.registryManagers(CUSTOM_REGISTRY_ID);
      assert.equal(mgr, registryManager, "wrong manager");
      await authoriser.removeRegistry(CUSTOM_REGISTRY_ID, { from: infrastructure });
      mgr = await authoriser.registryManagers(CUSTOM_REGISTRY_ID);
      assert.equal(mgr, ethers.constants.AddressZero, "removeRegistry() failed");
      // recreate the custom registry
      await authoriser.createRegistry(CUSTOM_REGISTRY_ID, registryManager, { from: infrastructure });
      mgr = await authoriser.registryManagers(CUSTOM_REGISTRY_ID);
      assert.equal(mgr, registryManager, "recreating the custom registry failed");
    });
    it("should not remove the Argent Registry", async () => {
      await truffleAssert.reverts(
        authoriser.removeRegistry(0, { from: infrastructure }), "DR: invalid _registryId"
      );
    });
    it("should not remove non-existing registry", async () => {
      await truffleAssert.reverts(
        authoriser.removeRegistry(66, { from: infrastructure }), "DR: unknown registry"
      );
    });
    it("should not recreate the Argent registry", async () => {
      await truffleAssert.reverts(
        authoriser.createRegistry(0, registryManager, { from: infrastructure }), "DR: invalid parameters"
      );
    });
    it("should not create a duplicate registry", async () => {
      await truffleAssert.reverts(
        authoriser.createRegistry(CUSTOM_REGISTRY_ID, registryManager, { from: infrastructure }), "DR: duplicate registry"
      );
    });
  });

  describe("add authorisation to registry", () => {
    it("should not allow non-owner to add authorisation to the Argent registry", async () => {
      await truffleAssert.reverts(
        authoriser.addAuthorisationToRegistry(0, contract.address, filter.address, { from: nonwhitelisted }), "DR: not authorised"
      );
    });
    it("should not add authorisation to non-existing registry", async () => {
      await truffleAssert.reverts(
        authoriser.addAuthorisationToRegistry(66, contract.address, filter.address, { from: nonwhitelisted }), "DR: unknow registry"
      );
    });
    it("should not allow non-manager to add authorisation to a registry", async () => {
      await truffleAssert.reverts(
        authoriser.addAuthorisationToRegistry(CUSTOM_REGISTRY_ID, contract.address, filter.address, { from: nonwhitelisted }), "DR: not authorised"
      );
    });
  });
});
