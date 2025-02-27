# Solana ZK Mixer

## Overview
Solana ZK Mixer is a privacy-preserving transaction protocol built on the Solana blockchain using **zero-knowledge proofs (ZKPs)**. This system allows users to deposit funds into a pool and later withdraw them anonymously, leveraging Merkle trees and zk-SNARKs.

## Features
- **Zero-Knowledge Proofs**: Uses Groth16 zk-SNARKs for verification without revealing inputs.
- **Merkle Tree-Based Privacy**: Users prove they deposited funds without exposing their identity.
- **Solana Smart Contract Integration**: Manages deposits, withdrawals, and ensures fund safety.
- **Efficient Poseidon Hashing**: Utilizes Poseidon for optimized on-chain hashing.
- **CLI-Based Interface**: Provides simple commands to interact with the mixer.

## Installation & Setup
### Prerequisites
- Node.js & npm
- Solana CLI installed
- Rust & Cargo installed
- Circom (for zk-SNARKs)
- SnarkJS library

### Clone the Repository
```sh
git clone https://github.com/your-repo/solana-zk-mixer.git
cd solana-zk-mixer
```

### Install Dependencies
```sh
npm install
```

### Compile Circom Circuits
```sh
circom mixer.circom --r1cs --wasm --sym
snarkjs groth16 setup mixer.r1cs pot12_final.ptau mixer_0000.zkey
snarkjs zkey contribute mixer_0000.zkey mixer_final.zkey --name="First contribution" -v
snarkjs zkey export verificationkey mixer_final.zkey mixer_vkey.json
```

## Usage
Run the CLI:
```sh
node cli.js
```

### Available Actions
1. **Initialize Pool**: Creates a new mixing pool.
2. **Deposit**: Deposits 0.1 SOL into the mixer.
3. **Generate Proof**: Generates a zk-SNARK proof for withdrawal.
4. **Withdraw**: Uses the proof to withdraw anonymously.
5. **Generate Merkle Tree**: Debugging tool to verify Merkle tree structure.
6. **Test Hash**: Computes a sample Poseidon hash.

## Technical Details
- Uses **Groth16 zk-SNARKs** for proof generation.
- Implements a **Merkle Tree** to track deposits.
- Uses **Poseidon hash function** for efficient zk-compatible hashing.
- Interacts with Solana blockchain using **@solana/web3.js**.

## Roadmap
 - Support an indefinetely growing tree (for the moment capped at 16 leaves per pool)

## License
MIT License. Contributions welcome!



