const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const prompt = require("prompt-sync")();
const bs58 = require("bs58");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const fs = require("fs");
const { ComputeBudgetProgram } = require('@solana/web3.js');

const PROGRAM_ID = new web3.PublicKey(
  "Ag36R1MUAHhyAYB96aR3JAScLqE6YFNau81iCcf2Y6RC"
);
const LAMPORTS_PER_SOL = 1_000_000_000;
const FIXED_DEPOSIT_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL);

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

// Generate a random nullifier and secret for deposit
function generateCommitment() {
  const nullifier = crypto.randomBytes(16); // 16 bytes
  const secret = crypto.randomBytes(16); // 16 bytes
  const commitment = crypto
    .createHash("sha256")
    .update(Buffer.concat([nullifier, secret]))
    .digest(); // 32 bytes
  return { nullifier, secret, commitment };
}

const IDENTIFIER = 1;
const seed1 = Buffer.from("pool_merkle");
const seed2 = (() => {
  buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(IDENTIFIER), 0);
  return buffer;
})();

const [poolPDA, bump] = web3.PublicKey.findProgramAddressSync(
  [seed1, seed2],
  PROGRAM_ID
);

// Function to initialize the pool
async function initializePool() {
  console.log("Initializing mixer pool...");
  const identifier = IDENTIFIER;
  const discriminator = getInstructionDiscriminator("global:initialize_pool");

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
    units: 800_000,
  });

  

  // Send the transaction
  const transaction = new web3.Transaction().add(computeBudgetIx).add(instruction);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Pool initialized. Transaction:", tx);
}

// Function to deposit
async function deposit() {
  console.log("Generating commitment...");
  const { nullifier, secret, commitment } = generateCommitment();

  console.log("Depositing 0.1 SOL...");

  const discriminator = getInstructionDiscriminator("global:deposit");
  const commitmentBuffer = (await commitment).toBuffer();
  if (commitmentBuffer.length != 32) {
    throw new Error("Commitment buffer not 32 bytes");
  }
  const instructionData = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    ProgramId: PROGRAM_ID,
    data: Buffer.concat([Buffer.from(discriminator), commitmentBuffer]), //How do iadd the commitment to the buffer ? the program expects a [u8, 32]
  });
  const transaction = new web3.Transaction().add(instructionData);
  const tx = await sendTransactionWithLogs(transaction);

  console.log("Deposit successful! Transaction:", tx);
  console.log("Save your nullifier and secret to withdraw later:");
  console.log("Nullifier:", bs58.encode(nullifier));
  console.log("Secret:", bs58.encode(secret));
}

// Function to deposit
async function withdraw() {
  console.log("Withdrawing funds necessitates nullifier and secret...");
  const nullifierBase58 = prompt("Enter your nullifier (Base58): ");
  const secretBase58 = prompt("Enter your secret (Base58): ");

  console.log("Depositing 0.1 SOL...");

  const discriminator = getInstructionDiscriminator("global:deposit");
  const commitmentBuffer = (await commitment).toBuffer();
  if (commitmentBuffer.length != 32) {
    throw new Error("Commitment buffer not 32 bytes");
  }
  const instructionData = new web3.TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      {
        pubkey: web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    programid: PROGRAM_ID,
    data: Buffer.concat([Buffer.from(discriminator), Buffer.from()]), //How do iadd the commitment to the buffer ? the program expects a [u8, 32]
  });
  const transaction = new web3.Transaction().add(instructionData);
  const tx = await sendTransactionWithLogs(transaction);
  console.log("Withdrawing success: ", tx);
}

// // Function to withdraw
// async function withdraw() {
//   const nullifierBase58 = prompt("Enter your nullifier (Base58): ");
//   const secretBase58 = prompt("Enter your secret (Base58): ");

//   const nullifier = bs58.decode(nullifierBase58);
//   const secret = bs58.decode(secretBase58);
//   const commitment = web3.PublicKey.createWithSeed(
//     new web3.PublicKey(bs58.encode(nullifier)),
//     "commitment",
//     PROGRAM_ID
//   );

//   console.log("Generating fake ZK proof (Placeholder)...");
//   const fakeProof = Buffer.from([1, 2, 3]); // Replace with a real ZK-SNARK proof later

//   console.log("Attempting withdrawal...");
//   const tx = await program.methods
//     .withdraw(fakeProof, commitment.toBuffer())
//     .accounts({
//       pool: poolPDA,
//       recipient: keypair.publicKey,
//       systemProgram: web3.SystemProgram.programId,
//     })
//     .signers([keypair])
//     .rpc();

//   console.log("Withdrawal successful! Transaction:", tx);
// }

// Function to prompt user
async function main() {
  console.log("\n=== SOLANA MIXER CLI ===");
  console.log("1) Initialize Pool");
  console.log("2) Deposit 0.1 SOL");
  console.log("3) Withdraw");
  const choice = prompt("Choose an option: ");

  switch (choice) {
    case "1":
      await initializePool();
      break;
    case "2":
      await deposit();
      break;
    case "3":
      await withdraw();
      break;
    default:
      console.log("Invalid choice. Exiting...");
  }
}

main();
