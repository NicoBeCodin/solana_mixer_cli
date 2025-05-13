const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const prompt = require("prompt-sync")();
var bs58 = require("bs58");
const crypto = require("crypto");
const { groth16, snarkjs } = require("snarkjs");
const fs = require("fs");
const { ComputeBudgetProgram } = require("@solana/web3.js");
const BN = require("bn.js");
const { poseidon1, poseidon2 } = require("poseidon-lite");
const { buildPoseidon } = require("circomlibjs");
const readlineSync = require("readline-sync");
const { buildBn128, utils } = require("ffjavascript");
const { unstringifyBigInts } = utils;
const {
  rebuildMMR,
  buildMerkleTree,
  getMerkleProof,
  padBatches,
  padBatchesRecursive,
  padWithDefaultLeaves,
  bigIntToU8Array,
  deepen,
} = require("./merkle_tree");
const { toBigInt } = require("ethers");
const { decode } = require("punycode");

// const PROGRAM_ID = new web3.PublicKey(
//   "Ag36R1MUAHhyAYB96aR3JAScLqE6YFNau81iCcf2Y6RC"
// );

const PROGRAM_ID = new web3.PublicKey(
  // "EKadvTET2vdCkurkYFu69v2iXdsAwHs3rQPj8XL5AUin"
  "URAeHt7FHf56ioY2XJNXbSx5Y3FbvQ9zeLGRpY1RiMD"
);
//Not used
const LEDGER_PROGRAM_ID = new web3.PublicKey(
  "7GHv6NewxZEFDjkUor8Ko3DG9BbMu9UwvHz9ZhgEsoZF"
);
const secondaryConnection = new web3.Connection(
  "https://rpc.ankr.com/solana_devnet",
  "confirmed"
);
const TARGET_SIZE = 1048576; //This corresponds to a 2**20
const TARGET_DEPTH=  20;
const LAMPORTS_PER_SOL = 1_000_000_000;
const POOL_SEED = Buffer.from("pool_merkle");
// Connect to Solana devnet
const connection = new web3.Connection(
  web3.clusterApiUrl("devnet"),
  "confirmed"
);

// Load local wallet
const walletPath = "/home/nico/new-kpr.json";
const secretKey = Uint8Array.from(
  JSON.parse(fs.readFileSync(walletPath, "utf8"))
);

const payer = web3.Keypair.fromSecretKey(secretKey);
// Pool PDA (Replace with the actual PDA address if needed)

/**
 * Compute the 8-byte instruction discriminator manually
 * @param {string} functionName - The Anchor instruction name (e.g., "global:deposit").
 * @returns {Buffer} - The first 8 bytes of the SHA-256 hash of the function name.
 */
function getInstructionDiscriminator(functionName) {
  const hash = crypto.createHash("sha256").update(functionName).digest();
  return hash.slice(0, 8);
}

function hashBigIntToBytes(hashBigInt) {
  const hashHex = hashBigInt.toString(16).padStart(64, "0");
  const hashBuffer = Buffer.from(hashHex, "hex");

  // Convert bytes to bigint for poseidon input
  console.log("Hash bigint", hashBigInt.toString());
  console.log("Hash buffer:", Array.from(hashBuffer));
  return hashBuffer;
}


async function sendTransactionWithLogs(transaction) {
  try {
    // Always fetch a fresh blockhash here
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer.publicKey;
    const signature = await web3.sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      {
        commitment: "confirmed",
        skipPreflight: false,
      }
    );
    console.log("Transaction confirmed with signature:", signature);
    const txDetails = await connection.getTransaction(signature, {
      commitment: "confirmed",
    });
    if (txDetails?.meta?.logMessages) {
      console.log("Transaction Logs:");
      txDetails.meta.logMessages.forEach((log) => console.log(log));
    }
    return signature;
  } catch (err) {
    console.error("Error during transaction:", err);
    throw err;
  }
}


async function generateLeaf(secret, nullifier) {
  const secretBuffer = Buffer.from(secret, "utf8");
  const nullifierBuffer = Buffer.from(nullifier, "utf8");
  const secretBigInt = BigInt("0x" + secretBuffer.toString("hex"));
  const nullifierBigInt = BigInt("0x" + nullifierBuffer.toString("hex"));
  const leafHash = poseidon2([secretBigInt, nullifierBigInt]);
  const hashBuffer = hashBigIntToBytes(leafHash);
  return hashBuffer;
}

function bigIntToBuffer(bigIntStr, byteSize) {
  let hexStr = BigInt(bigIntStr)
    .toString(16)
    .padStart(byteSize * 2, "0"); // Ensure it is the correct length
  return Buffer.from(hexStr, "hex");
}

function g1Uncompressed(curve, p1Raw) {
  let p1 = curve.G1.fromObject(p1Raw);

  let buff = new Uint8Array(64); // 64 bytes for G1 uncompressed
  curve.G1.toRprUncompressed(buff, 0, p1);

  return Buffer.from(buff);
}

function g2Uncompressed(curve, p2Raw) {
  let p2 = curve.G2.fromObject(p2Raw);

  let buff = new Uint8Array(128); // 128 bytes for G2 uncompressed
  curve.G2.toRprUncompressed(buff, 0, p2);

  return Buffer.from(buff);
}

function to32ByteBuffer(bigInt) {
  const hexString = bigInt.toString(16).padStart(64, "0");
  const buffer = Buffer.from(hexString, "hex");
  return buffer;
}

async function initializeTreasury() {
  // Compute the treasury PDA using the seed "treasury"
  const treasurySeed = Buffer.from("treasury");
  const [treasuryPDA, bump] = web3.PublicKey.findProgramAddressSync(
    [treasurySeed],
    PROGRAM_ID
  );

  // Get the 8-byte discriminator for "global:initializeTreasury"
  const discriminator = getInstructionDiscriminator(
    "global:initialize_treasury"
  );

  // In an Anchor program, the instruction data is just the discriminator if there are no extra arguments.
  const instructionData = Buffer.from(discriminator);

  // Create the instruction with the required accounts
  const instruction = new web3.TransactionInstruction({
    keys: [
      { pubkey: treasuryPDA, isSigner: false, isWritable: true }, // Treasury PDA (to be created)
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // Payer account
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      }, // System Program
    ],
    programId: PROGRAM_ID,
    data: instructionData,
  });

  // Create and send the transaction
  const transaction = new web3.Transaction().add(instruction);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Treasury initialization successful! TX:", tx);
}

// Function to initialize the pool
async function initializePool() {
  console.log("Initializing mixer pool...");
  const identifierString = prompt("Enter identifier: ");
  const discriminator = getInstructionDiscriminator("global:initialize_pool");

  // const seed3 = (() => {
  //   buffer = Buffer.alloc(8);
  //   buffer.writeBigUInt64LE(BigInt(identifier), 0);
  //   return buffer;
  // })();

  // Create a buffer for the identifier (assuming it's a u64)

  const creatorFeeBuffer = Buffer.alloc(8);
  const depositAmountBuffer = Buffer.alloc(8);

  const depositAmount = prompt("Enter the deposit amount in lamports: ");
  const creatorFee = prompt("Enter the creator fee in lamports: ");

  // Write the identifierString into the buffer

    const identifierBuffer = Buffer.alloc(16);
    identifierBuffer.write(identifierString, 0, "utf8");
  creatorFeeBuffer.writeBigUInt64LE(BigInt(creatorFee));
  depositAmountBuffer.writeBigUInt64LE(BigInt(depositAmount));

  const [poolPDA, bump] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, identifierBuffer],
    PROGRAM_ID
  );

  // Concatenate discriminator and identifier
  const instructionData = Buffer.concat([
    discriminator,
    identifierBuffer,
    depositAmountBuffer,
    creatorFeeBuffer,
  ]);

  // Check if the PDA already exists
  const pdaExists = await connection.getAccountInfo(poolPDA);
  if (pdaExists) {
    console.log("PDA already exists");
    return;
  }

  // Create the transaction instruction
  const instruction = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },

      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    programId: PROGRAM_ID,
    data: instructionData,
  });

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 500_000,
  });

  // Send the transaction
  const transaction = new web3.Transaction()
    .add(computeBudgetIx)
    .add(instruction);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Pool initialized. Transaction:", tx);
}

async function updateCurrentLeaves(poolAddress, leaf) {
  const accountInfo = await connection.getAccountInfo(poolAddress);
  if (!accountInfo) {
    console.log("Pool doesn't exist!");
    return null;
  }

  const data = Buffer.from(accountInfo.data);

  // Extract leaves (40 to 552, which is 512 bytes)
  const leaves = Buffer.from(data.slice(40, 40 + 512)); // Ensure mutable buffer
  const batchNumberLE = data.slice(648, 656);
  console.log("BatchNumberLE", batchNumberLE);
  const batchNumber = Buffer.alloc(8);

  // Convert batch number from LE to BE
  for (let i = 0; i < 8; i++) {
    batchNumber[i] = batchNumberLE[7 - i];
  }

  // Ensure leaf is exactly 32 bytes
  if (!Buffer.isBuffer(leaf)) {
    console.error("Leaf is not a Buffer. Converting...");
    leaf = Buffer.from(leaf); // Convert to Buffer if it's not already
  }

  if (leaf.length !== 32) {
    console.error("Error: Leaf must be exactly 32 bytes!");
    return null;
  }

  // Find first empty 32-byte slot (all zeroes)
  const emptyChunk = Buffer.alloc(32, 0); // A buffer of 32 zeroes
  let foundIndex = -1;

  for (let i = 0; i < 16; i++) {
    // 16 chunks of 32 bytes each
    const start = i * 32;
    const chunk = leaves.slice(start, start + 32);

    if (chunk.equals(emptyChunk)) {
      // Check if it's all zeros
      foundIndex = start;
      break;
    }
  }

  if (foundIndex !== -1) {
    console.log(`✅ Found empty slot at index ${foundIndex / 32}, updating...`);

    // Replace the empty slot with the new leaf
    leaf.copy(leaves, foundIndex);
  } else {
    console.log("❌ No empty slot found, all leaves are full.");
  }

  // Concatenate batchNumber + updated leaves
  const new_slice = Buffer.concat([batchNumber, leaves]);

  return new_slice;
}

const MEMO_PROGRAM_ID = new web3.PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// Function to deposit
async function deposit() {
  const identifierString = prompt("Enter identifier: ");
  console.log("Generating commitment...");

  const identifierBuffer = Buffer.alloc(16);
  identifierBuffer.write(identifierString, 0, "utf8");

  const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, identifierBuffer],
    PROGRAM_ID
  );
  // Generate secret and nullifier
  const secret = prompt("Enter secret: "); // Random secret
  const nullifier = prompt("Enter nullifier: "); // Unique nullifier
  console.log("\nSecret: ", secret);
  console.log("Nullifier: ", nullifier);
  const leaf = await generateLeaf(secret, nullifier);
  const leavesData = await updateCurrentLeaves(poolPDA, leaf);

  const memoText = leavesData.toString("base64");

  console.log("Constructing transaction...");
  const discriminator = getInstructionDiscriminator("global:deposit");

  // Create instruction data
  const instructionData = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true }, // Pool PDA
      { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // Nullifier list pda

      {
        pubkey: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([
      Buffer.from(discriminator),
      leaf,
      // leavesData
    ]),
  });
  const memoInstruction = new web3.TransactionInstruction({
    keys: [], // no accounts required for a memo
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memoText, "utf8"), // leavesData is a Buffer; if it's not, convert it appropriately
  });

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 700_000,
  });

  // Create and send the transaction
  let transaction = new web3.Transaction()
    .add(memoInstruction)
    .add(computeBudgetIx)
    .add(instructionData);


  const tx = await sendTransactionWithLogs(transaction);
  console.log("Deposit successful! ✅ TX:", tx);
}

async function depositMultiple(n) {
  const randomVal = crypto.randomBytes(1).readInt8();
  console.log("Random val is:", randomVal);

  const identifierString = prompt("Enter identifier: ");
  console.log("Using identifier:", identifierString);

  // Convert string to 16-byte UTF-8 buffer (zero-padded)
  const identifierBuffer = Buffer.alloc(16);
  identifierBuffer.write(identifierString, 0, "utf8");

  const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, identifierBuffer],
    PROGRAM_ID
  );

  for (let i = 1; i <= n; i++) {
    console.log(`\n--- Deposit iteration ${i} ---`);

    const secret = `secret${i + randomVal}`;
    const nullifier = `nullifier${i + randomVal}`;

    console.log("Secret:", secret);
    console.log("Nullifier:", nullifier);

    const leaf = await generateLeaf(secret, nullifier);
    const leavesData = await updateCurrentLeaves(poolPDA, leaf);

    const memoText = leavesData.toString("base64");

    console.log("Constructing transaction...");
    const discriminator = getInstructionDiscriminator("global:deposit");

    const depositIx = new web3.TransactionInstruction({
      keys: [
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        {
          pubkey: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: web3.SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      programId: PROGRAM_ID,
      data: Buffer.concat([
        Buffer.from(discriminator),
        leaf,
        // leavesData is passed via memo instead of instruction data
      ]),
    });

    const memoInstruction = new web3.TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoText, "utf8"),
    });

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 700_000,
    });

    let transaction = new web3.Transaction()
      .add(memoInstruction)
      .add(computeBudgetIx)
      .add(depositIx);

    try {
      const tx = await sendTransactionWithLogs(transaction);
      console.log(`✅ Deposit iteration ${i} successful! TX: ${tx}`);
    } catch (error) {
      console.error(`❌ Error during deposit iteration ${i}:`, error);
    }
  }
}

const customRPC = new web3.Connection(
  "https://devnet.helius-rpc.com/?api-key=a36697fc-de4a-44ca-993d-a0acacc65668",
  "confirmed"
);

async function getBatchesFromMemos(poolPDA) {
  let allSigInfos = [];
  let beforeSignature = null;
  const limit = 1000;

  while (true) {
    const options = { limit };
    if (beforeSignature) {
      options.before = beforeSignature;
    }

    const sigInfos = await connection.getSignaturesForAddress(poolPDA, options);
    if (sigInfos.length === 0) {
      break; // No more signatures to fetch
    }

    allSigInfos = allSigInfos.concat(sigInfos);
    beforeSignature = sigInfos[sigInfos.length - 1].signature;

    // If the number of fetched signatures is less than the limit, we've reached the earliest transactions
    if (sigInfos.length < limit) {
      break;
    }
  }

  console.log(allSigInfos);
  const batches = [];

  for (let i = 0; i < allSigInfos.length; i++) {
    const memoBase64 = allSigInfos[i].memo ? allSigInfos[i].memo.slice(4) : null; // Ignore first 4 bytes
    if (!memoBase64) {
      continue;
    }

    const memoBytes = Buffer.from(memoBase64, "base64");
    if (memoBytes.length !== 520) {
      console.log("Not 520 bytes long");
      console.log("memoBytes is: ", memoBytes);
      continue;
    }

    const lastBytes = memoBytes.slice(-32);
    const intValue = toBigInt(lastBytes);

    if (intValue !== 0n) {
      const batchId = toBigInt(memoBytes.slice(0, 8));
      console.log("Full batch found! n: ", batchId);
      const leaves = [];
      const leavesData = memoBytes.slice(8, 520);
      for (let j = 0; j < 16; j++) {
        const leafChunk = leavesData.slice(j * 32, (j + 1) * 32);
        const leaf = toBigInt(leafChunk);
        leaves.push(leaf);
      }
      console.log("Merkle tree built from this batch: ");
      buildMerkleTree(leaves);
      batches.push({ batchId, leaves, txSignature: allSigInfos[i].signature });
      if (batchId === 0n) {
        console.log("Found 0th batch, stopping the parsing");
        break;
      }
    }
  }

  batches.sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
  return batches;
}

async function generateDepositProofBatch() {
  try {
    // 1. Prompt user for input as a normal string
    const secret = prompt("Enter secret: ");
    // const secretBigInt = BigInt(secret);
    const nullifier = prompt("Enter nullifier: ");
    // const nullifierBigInt = BigInt(nullifier)

    // 2. Generate leaf hash using Poseidon
    const secretBuffer = Buffer.from(secret, "utf8");
    const nullifierBuffer = Buffer.from(nullifier, "utf8");
    const concatenated = Buffer.concat([secretBuffer, nullifierBuffer]);

    // 3. Convert Buffers to BigInts
    const concatenatedHex = concatenated.toString("hex");
    const secretBigInt = BigInt("0x" + secretBuffer.toString("hex"));
    const nullifierBigInt = BigInt("0x" + nullifierBuffer.toString("hex"));

    const inputBigInt = BigInt("0x" + concatenatedHex);
    const leafPreimage = inputBigInt;
    const nullifierHashed = poseidon1([nullifierBigInt]);
    console.log("Preimage secret+nullifier bigint", leafPreimage.toString());

    //This method is the one we choose now
    const hashv = poseidon2([secretBigInt, nullifierBigInt]);
    // 3. Prompt user for identifier
    const identifierString = prompt("Enter identifier: ");
    const identifierBuffer = Buffer.alloc(16);
    identifierBuffer.write(identifierString, 0, "utf8");

    const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
      [POOL_SEED, identifierBuffer],
      PROGRAM_ID
    );

    // const batches = await getBatchesForPool(identifier);
    const batches = await getBatchesFromMemos(poolPDA);

    const batchLeaves = batches.map((batch) => batch.leaves);
    for (let i = 0; i < batchLeaves.length; i++) {
      console.log("leaf", i, " ");
    }

    let paddedDefault = padWithDefaultLeaves(batchLeaves.flat()); //to next power of two

    const accountInfo = await connection.getAccountInfo(poolPDA);
    if (!accountInfo) {
      throw new Error("Failed to fetch account data for this pool PDA.");
    }
    const data = accountInfo.data;
  
    //root of the whole tree
    const wholeTreeRoot = data.slice(616, 648);
    const wholeTreeRootBigInt = BigInt("0x" + wholeTreeRoot.toString("hex"));

    console.log("On chain whole tree root as bigint: ", wholeTreeRootBigInt);
    console.log("Should match the tree generated offchain: ");
    const paddedTree = buildMerkleTree(paddedDefault);
    const computedPaddedRoot = paddedTree[paddedTree.length - 1][0];
    const deepenedHash = deepen(computedPaddedRoot, TARGET_DEPTH);

    let extended = paddedDefault.slice();
    for (let i = extended.length; i < TARGET_SIZE; i++) {
      extended.push(BigInt(0));
    }
    console.log("Extended tree size to: ", extended.length);

    const extendedTree = buildMerkleTree(extended);
    const extendedRoot = extendedTree[extendedTree.length - 1][0];
    console.log("generated extended tree root");

    const leafIndex = extended.findIndex((l) => l === hashv);
    if (leafIndex === -1) {
      throw new Error("Leaf not found in the Merkle tree.");
    }
    console.log("Leaf index is : ", leafIndex);

    //returns sibling path
    const proofPath = getMerkleProof(extendedTree, leafIndex);
    console.log("Proof path length: ", proofPath.length);
    // console.log("Proof path: ", proofPath);

    const inputs = {
      key: leafIndex,
      secret: secretBigInt,
      nullifier: nullifierBigInt,
      nullifierHash: nullifierHashed,
      root: extendedRoot,

      siblings: proofPath.reverse(),
    };

    console.log("Inputs for circuit:", inputs);

    const wasmPath = "./mixer_js/mixer.wasm";
    const zkeyPath = "./mixer_js/circuit_final.zkey";
    const vkeyPath = "./mixer_js/verification_key.json";
    // 11. Generate zero-knowledge proof
    const { proof, publicSignals } = await groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath
    );

    console.log("Generated proof:", proof);

    console.log("Public signals:", publicSignals);

    // 12. Load verification key
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    // console.log("Verification key: ", vkey);

    // 13. Validate proof with vkey
    const isValid = await groth16.verify(vkey, publicSignals, proof);
    if (!isValid) {
      throw new Error(
        "Proof verification failed! The vkey does not match the proof."
      );
    }

    return { proof, publicSignals, verificationKey: vkey };
  } catch (error) {
    console.error("Error generating proof:", error);
    throw error;
  }
}

async function withdraw(proof, publicSignals) {
  console.log("Building transaction toverify groth16 proof...");
  let curve = await buildBn128();
  let proofProc = unstringifyBigInts(proof);
  publicSignals = unstringifyBigInts(publicSignals);

  const pi_a = g1Uncompressed(curve, proofProc.pi_a);
  const pi_b = g2Uncompressed(curve, proofProc.pi_b);
  const pi_c = g1Uncompressed(curve, proofProc.pi_c);

  const nullifierPublicSignalBuffer = to32ByteBuffer(BigInt(publicSignals[0]));
  const rootPublicSignalBuffer = to32ByteBuffer(BigInt(publicSignals[1]));
  let public_signal_0_u8_array = Array.from(
    Buffer.concat([rootPublicSignalBuffer, nullifierPublicSignalBuffer])
  );
  console.log("Public signal array: ", public_signal_0_u8_array);

  const discriminator = getInstructionDiscriminator("global:withdraw");
  const serializedData = Buffer.concat([
    discriminator,
    pi_a,
    pi_b,
    pi_c,
    nullifierPublicSignalBuffer,
    rootPublicSignalBuffer,
  ]);

  const identifierString = readlineSync.question("Pool identifier: ");
  const identifierBuffer = Buffer.alloc(16);
  identifierBuffer.write(identifierString, 0, "utf8");

  
  const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, identifierBuffer],
    PROGRAM_ID
  );
  
  const poolInfo = await connection.getAccountInfo(poolPDA);
  const creatorPubkeyData= poolInfo.data.slice(568, 568+32);
  const creatorPubkey = new web3.PublicKey(creatorPubkeyData);

  
  const [nullifierAccount, bump_nullifier_account] =
    web3.PublicKey.findProgramAddressSync(
      [nullifierPublicSignalBuffer],
      PROGRAM_ID
    );

  const treasurySeed = Buffer.from("treasury");
  const [treasuryPDA, bump] = web3.PublicKey.findProgramAddressSync(
    [treasurySeed],
    PROGRAM_ID
  );
  // Create the transaction instruction
  const instruction = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: nullifierAccount, isSigner: false, isWritable: true },
      { pubkey: creatorPubkey, isSigner: false, isWritable: true},
      { pubkey: treasuryPDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    programId: PROGRAM_ID,
    data: serializedData,
  });

  // Set a high compute budget for verification
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  try {
    // Send the transaction
    const transaction = new web3.Transaction()
      .add(computeBudgetIx)
      .add(instruction);
    const tx = await sendTransactionWithLogs(transaction, payer, connection);
    console.log("Proof verification sent. Transaction:", tx);
  } catch (err) {
    console.log("Something went wrong during transaction...");
  }
}

async function adminTransfer() {
  // Ask for inputs.
  const identifierStr = prompt("Enter pool identifier (as number):");
  const identifier = parseInt(identifierStr);
  const amountStr = prompt("Enter amount to transfer in SOL:");
  const amount = BigInt(amountStr * 1000000000);

  // Derive the pool PDA using seeds [b"pool_merkle", identifier.to_le_bytes()]
  const seedBuffer = Buffer.alloc(8);
  seedBuffer.writeBigUInt64LE(BigInt(identifier));
  const [poolPDA, poolBump] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, seedBuffer],
    PROGRAM_ID
  );

  // Build the instruction data:
  // Discriminator (8 bytes) || amount (8 bytes) || identifier (8 bytes)
  const discriminator = getInstructionDiscriminator("global:admin_transfer");
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(amount);
  const identifierBuffer = Buffer.alloc(8);
  identifierBuffer.writeBigUInt64LE(BigInt(identifier));

  const instructionData = Buffer.concat([
    discriminator,
    amountBuffer,
    identifierBuffer,
  ]);

  // Build the instruction:
  // Accounts:
  // 1. Pool PDA (writable, not signer)
  // 2. Recipient (writable)
  // 3. Admin (signer)
  // 4. SystemProgram (readonly)
  const keys = [
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // Admin is the payer
    {
      pubkey: web3.SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
  ];

  const ix = new web3.TransactionInstruction({
    keys,
    programId: PROGRAM_ID,
    data: instructionData,
  });

  // Build the transaction.
  const transaction = new web3.Transaction().add(ix);

  // Sign and send the transaction.

  const tx = await sendTransactionWithLogs(transaction, payer, connection);
  console.log("Succesfully transfered sol:", tx);
}

// Function to prompt user
async function main() {
  let proof = null;
  let publicSignals = null;
  let vkey = null;

  while (true) {
    console.log("\n=== SOLANA MIXER CLI ===");
    console.log("1) Initialize Pool");
    console.log("2) Deposit 0.1 SOL");
    console.log("3) Generate proof (deprecated method for testing purposes) ");
    console.log("4) Generate proof with batches");
    console.log("5) Send proof & withdraw");
    console.log("6) Deposit multiple (Testing purposes)");
    console.log("7) Admin transfer (Testing purposes)");
    console.log("8) Generate a merkle tree (Testing purposes)");
    console.log("9) Initialize treasury");
    // The function to deposit n times using secret{i} and nullifier{i}
    const choice = readlineSync.question("Choose an option: ");

    switch (choice) {
      case "1":
        await initializePool();
        break;
      case "2":
        await deposit();
        break;
      case "3":
        ({
          proof,
          publicSignals,
          verificationKey: vkey,
        } = await generateDepositProof());
        console.log("Proof stored for verification.");
        break;
      case "4":
        ({
          proof,
          publicSignals,
          verificationKey: vkey,
        } = await generateDepositProofBatch());
        console.log("Proof stored for verification.");
        break;
      case "5":
        if (!proof) {
          console.log("No proof loaded yet");
        } else {
          await withdraw(proof, publicSignals);
        }
        break;
      case "6":
        const n = readlineSync.question("How many deposits ? ");
        await depositMultiple(n);
        break;
      case "7":
        await adminTransfer();
        break;
      case "8":
        const depth = readlineSync.question(
          "How deep should the merkle tree be ?"
        );
        let defaultLeaves = [];
        for (let i = 0; i < 2 ** depth; i++) {
          defaultLeaves.push(BigInt(0));
        }
        buildMerkleTree(defaultLeaves);
        break;
      case "9":
        await initializeTreasury();
        break;
      default:
        console.log("Invalid choice. Try again.");
    }
  }
}

main();

