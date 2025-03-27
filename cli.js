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
const TARGET_SIZE = 256;
const LAMPORTS_PER_SOL = 1_000_000_000;
const FIXED_DEPOSIT_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL);
const POOL_SEED = Buffer.from("pool_merkle");
const NULLIFIER_SEED = Buffer.from("nullifier");
const LEDGER_SEED = Buffer.from("ledger");
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
// async function sendTransactionWithLogs(transaction) {
//   try {
//     const signature = await web3.sendAndConfirmTransaction(
//       connection,
//       transaction,
//       [payer]
//     );
//     console.log("Transaction confirmed with signature:", signature);

//     // Fetch and display logs
//     const txDetails = await connection.getTransaction(signature, {
//       commitment: "confirmed",
//     });
//     if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
//       console.log("Transaction Logs:");
//       txDetails.meta.logMessages.forEach((log) => console.log(log));
//     }
//     return signature;
//   } catch (err) {
//     console.error("Error during transaction:", err);
//     throw err;
//   }
// }

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
  const sigInfos = await connection.getSignaturesForAddress(poolPDA, {
    limit: 1000,
  });

  console.log(sigInfos);
  const batches = [];
  for (let i = 0; i < sigInfos.length; i++) {
    let memoBase64 = sigInfos[i].memo.slice(4, ); //Ignore first 4 bytes
    if (!memoBase64) {
      continue;
    } else {
      const memoBytes = Buffer.from(memoBase64, "base64");
      if (memoBytes.length != 520) {
        console.log("Not 520 bytes long");
        console.log("memoBytes is: ", memoBytes);
      } else {
        const lastBytes = memoBytes.slice(
          memoBytes.length - 32,
          memoBytes.length
        );
        // console.log("Last bytes: ", lastBytes);
        const intValue = toBigInt(lastBytes);
        //Identify non zero batches
        if (intValue != 0) {
          const batchId = toBigInt(memoBytes.slice(0, 8));
          console.log("Full batch found! n: ", batchId);
          const leaves = [];
          const leavesData = memoBytes.slice(8, 520);
          for (let j = 0; j < 16; j++) {
            const leafChunk = leavesData.slice(j * 32, (j + 1) * 32);
            // const leaf = BigInt("0x" + leafChunk.toString("hex"));
            const leaf = toBigInt(leafChunk);
            // console.log("Leaf: ", leaf);
            leaves.push(leaf);
          }
          console.log("Merkle tree built from this batch: ");
          buildMerkleTree(leaves);
          batches.push({ batchId, leaves, txSignature: sigInfos[i].signature });
          if (batchId == 0) {
            console.log("Found 0th batch, stopping the parsing");
            i = 999999;
            break;
          }
        } 

      }
    }
  }
  batches.sort((a, b) =>
    a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0
  );
  return batches;
}

async function getBatchesFromTransactions(poolPDA) {
  const sigInfos = await connection.getSignaturesForAddress(poolPDA, {
    limit: 1000,
  });

  console.log(sigInfos);
  const connections = [customRPC];
  const batches = [];

  const limit = Math.min(sigInfos.length, 10000);
  for (let i = 0; i < limit; i++) {
    const sigInfo = sigInfos[i];
    console.log("Memo length:", sigInfos[i].memo.length);
    const tmp_connection = connections[i % connections.length];
    // Delay to avoid rate limits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const tx = await tmp_connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.transaction) {
        console.log("Failed to fetch transaction:", sigInfo.signature);
        continue;
      }
      let instr = tx.transaction.message.instructions;

      let instrData = tx.transaction.message.instructions[1].data;
      let decodedData = bs58.default.decode(instrData);
      const decodedLength = decodedData.length;
      if (decodedLength == 560) {
        // console.log("tx: ", instr);
        if (decodedLength == 560) {
          const lastBytes = decodedData.slice(
            decodedLength - 32,
            decodedLength
          );
          // console.log("Last bytes: ", lastBytes);
          const intValue = toBigInt(lastBytes);
          //Identify non zero batches
          if (intValue != 0) {
            const batchId = toBigInt(decodedData.slice(40, 48));
            console.log("Full batch found! n: ", batchId);
            const leaves = [];
            const leavesData = decodedData.slice(560 - 512, 560);
            for (let j = 0; j < 16; j++) {
              const leafChunk = leavesData.slice(j * 32, (j + 1) * 32);
              // const leaf = BigInt("0x" + leafChunk.toString("hex"));
              const leaf = toBigInt(leafChunk);
              // console.log("Leaf: ", leaf);
              leaves.push(leaf);
            }
            console.log("Merkle tree built from this batch: ");
            buildMerkleTree(leaves);
            batches.push({ batchId, leaves, txSignature: sigInfo.signature });
            if (batchId == 0) {
              console.log("Found 0th batch, stopping the parsing");
              i = 999999;
              break;
            }
          } else {
            //Nothing happens we keep parsing
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching transaction ${sigInfo.signature}:`, error);
      continue;
    }
  }
  // Sort batches by batchId (ascending: oldest first)
  batches.sort((a, b) =>
    a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0
  );
  return batches;
}

//parses the solana ledger to fecth inner instructions that contain the leaves batches
async function getBatchesForPool(targetIdentifier) {
  const targetId = BigInt(targetIdentifier);
  const ledgerProgramPubkey = LEDGER_PROGRAM_ID; // Should be a PublicKey instance.
  const connections = [connection, secondaryConnection]; // Use alternate connections to avoid rate limits.
  const sigInfos = await connection.getSignaturesForAddress(
    ledgerProgramPubkey,
    { limit: 1000 }
  );
  const batches = [];
  // console.log("sigInfos:", sigInfos);
  console.log("Number of signatures:", sigInfos.length);

  // For demonstration, we'll process only the first few signatures.
  const limit = Math.min(sigInfos.length, 999);
  for (let i = 0; i < limit; i++) {
    const sigInfo = sigInfos[i];
    const tmp_connection = connections[i % connections.length];
    // Delay to avoid rate limits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const tx = await tmp_connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.transaction) {
        console.log("Failed to fetch transaction:", sigInfo.signature);
        continue;
      }

      // console.log("Transaction::: ",tx.transaction);
      for (const instr of tx.meta.innerInstructions) {
        let innerInstructionData = instr.instructions[0].data;
        // Decode the instruction data from base58.
        const data = bs58.default.decode(innerInstructionData);
        // const data = Buffer.from(decodeBase58(instr.data.toString()))
        if (data.length < 530) continue; // Not long enough for our store_batch data.
        // console.log("Data after decode: ", data);

        // Bytes 0-7: Discriminator (ignored)
        // Bytes 8-15: Pool identifier (u64, little-endian)

        const id = toBigInt(data.slice(8, 16).reverse());
        // console.log("Parsed pool ID: ", id);
        if (id !== targetId) continue;

        // Bytes 16-23: Batch number (u64, little-endian)
        const batchId = toBigInt(data.slice(16, 24).reverse());

        // Bytes 24-535: 512 bytes for 16 leaves (32 bytes each)
        const leaves = [];
        const leavesData = data.slice(24, 536);
        for (let j = 0; j < 16; j++) {
          const leafChunk = leavesData.slice(j * 32, (j + 1) * 32);
          // const leaf = BigInt("0x" + leafChunk.toString("hex"));
          const leaf = toBigInt(leafChunk);
          // console.log("Leaf: ", leaf);
          leaves.push(leaf);
        }

        console.log("Parsed Pool Identifier:", id);
        console.log("Parsed Leaves:", leaves);

        console.log("Parsed Batch Number:", batchId);
        batches.push({ batchId, leaves, txSignature: sigInfo.signature });
        if (batchId == 0) {
          console.log("batchID 0 found, stopping the parsing");
          i = 9999;
          break;
        }
      }
    } catch (error) {
      console.error(`Error fetching transaction ${sigInfo.signature}:`, error);
      continue;
    }
  }

  // Sort batches by batchId (ascending: oldest first)
  batches.sort((a, b) =>
    a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0
  );
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

    // 6. Extract Merkle root
    const rootData = data.slice(8, 40);
    // 7. Extract leaves

    //root of the whole tree
    const wholeTreeRoot = data.slice(616, 648);
    const wholeTreeRootBigInt = BigInt("0x" + wholeTreeRoot.toString("hex"));

    console.log("On chain whole tree root as bigint: ", wholeTreeRootBigInt);
    console.log("Should match the tree generated offchain: ");
    const paddedTree = buildMerkleTree(paddedDefault);
    const computedPaddedRoot = paddedTree[paddedTree.length - 1][0];
    const deepenedHash = deepen(computedPaddedRoot, 6);

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
    const zkeyPath = "circuit_final.zkey";
    const vkeyPath = "verification_key.json";
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

// //Old method
// async function generateDepositProof() {
//   try {
//     // 1. Prompt user for input as a normal string
//     const secret = prompt("Enter secret: ");
//     // const secretBigInt = BigInt(secret);
//     const nullifier = prompt("Enter nullifier: ");
//     // const nullifierBigInt = BigInt(nullifier)

//     // 2. Generate leaf hash using Poseidon
//     const secretBuffer = Buffer.from(secret, "utf8");
//     const nullifierBuffer = Buffer.from(nullifier, "utf8");
//     const concatenated = Buffer.concat([secretBuffer, nullifierBuffer]);

//     // 3. Convert Buffers to BigInts
//     const concatenatedHex = concatenated.toString("hex");
//     const secretBigInt = BigInt("0x" + secretBuffer.toString("hex"));
//     const nullifierBigInt = BigInt("0x" + nullifierBuffer.toString("hex"));

//     const inputBigInt = BigInt("0x" + concatenatedHex);
//     const leafPreimage = inputBigInt;
//     const nullifierHashed = poseidon1([nullifierBigInt]);
//     console.log("Preimage secret+nullifier bigint", leafPreimage.toString());

//     //This method is the one we choose now
//     const hashv = poseidon2([secretBigInt, nullifierBigInt]);
//     // 3. Prompt user for identifier
//     const identifier = prompt("Enter identifier: ");

//     // 4. Derive the pool PDA
//     const seed2 = (() => {
//       const buffer = Buffer.alloc(8);
//       buffer.writeBigUInt64LE(BigInt(identifier), 0);
//       return buffer;
//     })();

//     const [poolPDA, bump] = web3.PublicKey.findProgramAddressSync(
//       [POOL_SEED, seed2],
//       PROGRAM_ID
//     );

//     // 5. Fetch Merkle tree data from PDA
//     const accountInfo = await connection.getAccountInfo(poolPDA);
//     if (!accountInfo) {
//       throw new Error("Failed to fetch account data for this pool PDA.");
//     }
//     const data = accountInfo.data;

//     // 6. Extract Merkle root
//     const rootData = data.slice(8, 40);
//     const rootBigInt = BigInt("0x" + rootData.toString("hex"));
//     console.log("On chain root as bigint: ", rootBigInt);

//     // 7. Extract leaves
//     const leavesData = data.slice(40, 552); //For 16 leaves
//     const leaves = [];
//     for (let i = 0; i < 16; i++) {
//       const leafChunk = leavesData.slice(i * 32, (i + 1) * 32);
//       const bigIntLeaf = BigInt("0x" + leafChunk.toString("hex"));
//       console.log("bigIntLeaf", bigIntLeaf);
//       leaves.push(bigIntLeaf);
//     }

//     const tree = buildMerkleTree(leaves);

//     let defaultLeaves = [];
//     for (let i = 0; i < 16; i++) {
//       console.log("BigInt(0)", BigInt(0));
//       defaultLeaves.push(BigInt(0));
//     }
//     console.log("Other tree");
//     buildMerkleTree(defaultLeaves);

//     // 8. Find the leaf index
//     const leafIndex = leaves.findIndex((l) => l === hashv);
//     if (leafIndex === -1) {
//       throw new Error("Leaf not found in the Merkle tree.");
//     }
//     console.log("Leaf index is : ", leafIndex);

//     const proofPath = getMerkleProof(tree, leafIndex);
//     console.log("Proof path: ", proofPath);

//     const inputs = {
//       key: leafIndex,
//       secret: secretBigInt,
//       nullifier: nullifierBigInt,
//       nullifierHash: nullifierHashed,
//       root: rootBigInt,
//       siblings: proofPath.reverse(),
//     };

//     console.log("Inputs for circuit:", inputs);

//     const wasmPath = "./mixer_js/mixer.wasm";
//     const zkeyPath = "mixer_final.zkey";
//     const vkeyPath = "mixer_vkey.json";
//     // 11. Generate zero-knowledge proof
//     const { proof, publicSignals } = await groth16.fullProve(
//       inputs,
//       wasmPath,
//       zkeyPath
//     );

//     console.log("Generated proof:", proof);
//     console.log("Public signals:", publicSignals);

//     // 12. Load verification key
//     const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
//     console.log("Verification key: ", vkey);

//     // 13. Validate proof with vkey
//     const isValid = await groth16.verify(vkey, publicSignals, proof);
//     if (!isValid) {
//       throw new Error(
//         "Proof verification failed! The vkey does not match the proof."
//       );
//     }

//     return { proof, publicSignals, verificationKey: vkey };
//   } catch (error) {
//     console.error("Error generating proof:", error);
//     throw error;
//   }
// }
