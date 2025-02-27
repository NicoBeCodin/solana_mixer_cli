const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const prompt = require("prompt-sync")();
const bs58 = require("bs58");
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

const PROGRAM_ID = new web3.PublicKey(
  "Ag36R1MUAHhyAYB96aR3JAScLqE6YFNau81iCcf2Y6RC"
);
const LAMPORTS_PER_SOL = 1_000_000_000;
const FIXED_DEPOSIT_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL);
const POOL_SEED = Buffer.from("pool_merkle");
const NULLIFIER_SEED =  Buffer.from("nullifier");
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
// Utility: Send and confirm a transaction with logs, payer is default signer
async function sendTransactionWithLogs(transaction) {
  try {
    const signature = await web3.sendAndConfirmTransaction(
      connection,
      transaction,
      [payer]
    );
    console.log("Transaction confirmed with signature:", signature);

    // Fetch and display logs
    const txDetails = await connection.getTransaction(signature, {
      commitment: "confirmed",
    });
    if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
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
// Function to initialize the pool
async function initializePool() {
  console.log("Initializing mixer pool...");
  const identifier = prompt("Enter identifier: ");
  const discriminator = getInstructionDiscriminator("global:initialize_pool");


  const seed3 = (() => {
    buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(identifier), 0);
    return buffer;
  })();
  const [poolPDA, bump] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, seed3],
    PROGRAM_ID
  );
  const [nullifierPDA, bump_nullifiers] = web3.PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, seed3],
    PROGRAM_ID
  );

  // Create a buffer for the identifier (assuming it's a u64)
  const identifierBuffer = Buffer.alloc(8);
  identifierBuffer.writeBigUInt64LE(BigInt(identifier));

  // Concatenate discriminator and identifier
  const instructionData = Buffer.concat([discriminator, identifierBuffer]);

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
      { pubkey: nullifierPDA, isSigner: false, isWritable: true }, // User making the deposit
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
    units: 1_000_000,
  });

  // Send the transaction
  const transaction = new web3.Transaction()
    .add(computeBudgetIx)
    .add(instruction);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Pool initialized. Transaction:", tx);
}

// Function to deposit
async function deposit() {
  const identifier = prompt("Enter identifier: ");
  console.log("Generating commitment...");

  
  const seed2 = (() => {
    buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(identifier), 0);
    return buffer;
  })();

  const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, seed2],
    PROGRAM_ID
  );

  // Generate secret and nullifier
  const secret = prompt("Enter secret: "); // Random secret
  const nullifier = prompt("Enter nullifier: "); // Unique nullifier
  console.log("\nSecret: ", secret);
  console.log("Nullifier: ", nullifier);
  const leaf = await generateLeaf(secret, nullifier);

  console.log("Constructing transaction...");
  const discriminator = getInstructionDiscriminator("global:deposit");

  // Create instruction data
  const instructionData = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true }, // Pool PDA
      { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // Nullifier list pda
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([Buffer.from(discriminator), leaf]),
  });

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  // Create and send the transaction
  const transaction = new web3.Transaction()
    .add(computeBudgetIx)
    .add(instructionData);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Deposit successful! ✅ TX:", tx);
}

async function generateDepositProof() {
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
    const identifier = prompt("Enter identifier: ");

    // 4. Derive the pool PDA
    const seed2 = (() => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(BigInt(identifier), 0);
      return buffer;
    })();

    const [poolPDA, bump] = web3.PublicKey.findProgramAddressSync(
      [POOL_SEED, seed2],
      PROGRAM_ID
    );

    // 5. Fetch Merkle tree data from PDA
    const accountInfo = await connection.getAccountInfo(poolPDA);
    if (!accountInfo) {
      throw new Error("Failed to fetch account data for this pool PDA.");
    }
    const data = accountInfo.data;

    // 6. Extract Merkle root
    const rootData = data.slice(8, 40);
    const rootBigInt = BigInt("0x" + rootData.toString("hex"));
    console.log("On chain root as bigint: ", rootBigInt);

    // 7. Extract leaves
    const leavesData = data.slice(40, 552);//For 16 leaves
    const leaves = [];
    for (let i = 0; i < 16; i++) {
      const leafChunk = leavesData.slice(i * 32, (i + 1) * 32);
      leaves.push(BigInt("0x" + leafChunk.toString("hex")));
    }

    // 8. Find the leaf index
    const leafIndex = leaves.findIndex((l) => l === hashv);
    if (leafIndex === -1) {
      throw new Error("Leaf not found in the Merkle tree.");
    }
    console.log("Leaf index is : ", leafIndex);

    const tree = buildMerkleTree(leaves);
    const proofPath = getMerkleProof(tree, leafIndex);
    console.log("Proof path: ", proofPath);

    const inputs = {
      key: leafIndex,
      secret: secretBigInt,
      nullifier: nullifierBigInt,
      nullifierHash: nullifierHashed,
      root: rootBigInt,
      siblings: proofPath.reverse(),
    };

    console.log("Inputs for circuit:", inputs);

    const wasmPath = "./mixer_js/mixer.wasm";
    const zkeyPath = "mixer_final.zkey";
    const vkeyPath = "mixer_vkey.json";
    // 11. Generate zero-knowledge proof
    const { proof, publicSignals, } = await groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath
    );

    console.log("Generated proof:", proof);
    console.log("Public signals:", publicSignals);

    // 12. Load verification key
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
    console.log("Verification key: ", vkey);

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
function buildMerkleTree(leaves) {
  // Start the tree with the leaves as the 0th level
  const tree = [];
  tree[0] = leaves.slice(); // Copy leaves to avoid mutating original

  let level = 0;
  // Keep combining until we reach a single element (the root)
  while (tree[level].length > 1) {
    const currentLevel = tree[level];
    const nextLevel = [];

    // Since leaves.length is always a power of two, i+1 will never go out of bounds
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];
      nextLevel.push(poseidon2([left, right]));
    }

    tree.push(nextLevel);
    level++;
  }
  let size = tree.length;
  const rootHash = tree[size-1][0]
  console.log("root hash: ", rootHash);

  return tree;
}

function getMerkleProof(tree, leafIndex) {
  const proof = [];
  let index = leafIndex;

  console.log("Merkle proof process started");

  for (let level = 0; level < tree.length - 1; level++) {
    const isRightNode = index % 2 === 1; // Check if index is odd (right node)
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < tree[level].length) {
      proof.push(tree[level][siblingIndex]);
    } else {
      console.warn(`Sibling index ${siblingIndex} out of bounds at level ${level}`);
    }

    // Move up in the tree
    index = Math.floor(index / 2);
  }

  return proof;
}


async function withdraw(proof, publicSignals) {
  console.log("Building transaction toverify groth16 proof...");
  console.log("publicSignals: ", publicSignals);
  console.log("proof", proof);
  let curve = await buildBn128();
  let proofProc = unstringifyBigInts(proof);
  publicSignals = unstringifyBigInts(publicSignals);

  let pi_a = g1Uncompressed(curve, proofProc.pi_a);
  let pi_a_0_u8_array = Array.from(pi_a);

  const pi_b = g2Uncompressed(curve, proofProc.pi_b);
  let pi_b_0_u8_array = Array.from(pi_b);
  console.log(pi_b_0_u8_array.slice(0, 64));
  console.log(pi_b_0_u8_array.slice(64, 128));

  const pi_c = g1Uncompressed(curve, proofProc.pi_c);
  let pi_c_0_u8_array = Array.from(pi_c);
  console.log(pi_c_0_u8_array);

  const rootPublicSignalBuffer = to32ByteBuffer(BigInt(publicSignals[0]));
  const nullifierPublicSignalBuffer = to32ByteBuffer(BigInt(publicSignals[1]));
  let public_signal_0_u8_array = Array.from(Buffer.concat([rootPublicSignalBuffer, nullifierPublicSignalBuffer]));
  console.log("public signal array: ", public_signal_0_u8_array);


  const discriminator = getInstructionDiscriminator("global:withdraw");
  const serializedData = Buffer.concat([
    discriminator,
    pi_a,
    pi_b,
    pi_c,
    rootPublicSignalBuffer,
    nullifierPublicSignalBuffer,
  ]);


  const identifier = readlineSync.question("Pool identifier: ");

  const seed3 = (() => {
    buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(identifier), 0);
    return buffer;
  })();

  const [poolPDA, bump_pool] = web3.PublicKey.findProgramAddressSync(
    [POOL_SEED, seed3],
    PROGRAM_ID
  );
  console.log("Pool bump:", bump_pool);
  
  const [nullifierPDA, bump_nullifier] = web3.PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, seed3],
    PROGRAM_ID
  );
  // Create the transaction instruction
  const instruction = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
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
    units: 1_300_000,
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

// Function to prompt user
async function main() {
  let proof = null;
  let publicSignals = null;
  let vkey = null;

  while (true) {
    console.log("\n=== SOLANA MIXER CLI ===");
    console.log("1) Initialize Pool");
    console.log("2) Deposit 0.1 SOL");
    console.log("3) generate proof");
    console.log("4) Send proof & withdraw");

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
        if (!proof) {
          console.log("No proof loaded yet");
        } else {
          await withdraw(proof, publicSignals);
        }
        break;
      default:
        console.log("Invalid choice. Try again.");
    }
  }
}
main();
