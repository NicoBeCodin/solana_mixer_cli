import {poseidon2} from "poseidon-lite" ;

/**
 * Computes the Merkle root of a single batch of 16 leaves.
 * Leaves are given as an array of BigInts.
 * We convert each leaf to a 32-byte hex string and then build a Merkle tree by pairwise hashing.
 * @param {BigInt[]} leaves - Array of 16 BigInts.
 * @returns {string} - The computed batch root as a hex string.
 */
export function computeBatchRoot(leaves) {
    if (leaves.length !== 16) throw new Error("Expected 16 leaves");
    // Convert each BigInt leaf to a 32-byte hex string.
    let nodes = leaves.map(x =>
      "0x" + x.toString(16).padStart(64, "0")
    );
    // Build the tree level by level.
    while (nodes.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < nodes.length; i += 2) {
        nextLevel.push(hashv(nodes[i], nodes[i + 1]));
      }
      nodes = nextLevel;
    }
    return nodes[0];
  }
  
  /**
   * Updates a peak stack given a new batch hash.
   * The peak stack is represented by two arrays:
   *   peaks: an array of hex strings (each a 32-byte hash)
   *   depths: a parallel array of numbers (each the depth of the corresponding peak)
   * When two rightmost peaks have the same depth, they are merged.
   * @param {string[]} peaks - Current array of peak hashes.
   * @param {number[]} depths - Current array of peak depths.
   * @param {string} newBatchHash - New batch hash as a hex string.
   * @returns {Object} - { peaks, depths } updated.
   */
export function updatePeaks(peaks, depths, newBatchHash) {
    peaks.push(newBatchHash);
    depths.push(0); // new batch has depth 0.
    while (peaks.length >= 2 && depths[peaks.length - 1] === depths[peaks.length - 2]) {
      const right = peaks.pop();
      const left = peaks.pop();
      const depth = depths.pop(); // same depth for both.
      depths.pop();
      const merged = hashv(left, right);
      peaks.push(merged);
      depths.push(depth + 1);
    }
    return { peaks, depths };
  }
  
  /**
   * Computes the overall MMR root from a peak stack (peaks array).
   * The peaks are combined left-to-right by hashing.
   * @param {string[]} peaks - Array of peak hashes.
   * @returns {string} - The overall root as a hex string.
   */
export function computeRootFromPeaks(peaks) {
    if (peaks.length === 0) return "0x" + "0".repeat(64);
    let current = peaks[0];
    for (let i = 1; i < peaks.length; i++) {
      current = hashv(current, peaks[i]);
    }
    return current;
  }
  
  /**
   * Rebuilds the Merkle Mountain Range from parsed batch data.
   * For each batch, compute its batch root from the 16 leaves.
   * Then, using the batches sorted by batchId ascending, update the peak stack.
   * Finally, compute the overall root from the peak stack.
   * @param {Array<{ batchId: bigint, leaves: BigInt[] }>} batches
   * @returns {string} - The overall MMR root as a hex string.
   */
  export function rebuildMMR(batches) {
    // Initialize empty peak stack.
    let peaks = [];
    let depths = [];
    // Process each batch in order (oldest first)
    for (const batch of batches) {
      const batchRoot = computeBatchRoot(batch.leaves);
      ({ peaks, depths } = updatePeaks(peaks, depths, batchRoot));
    }
    // Compute overall root by combining peaks left-to-right.
    return computeRootFromPeaks(peaks);
  }
  
  
  function to32ByteBuffer(bigInt) {
    const hexString = bigInt.toString(16).padStart(64, "0");
    const buffer = Buffer.from(hexString, "hex");
    return buffer;
  }
  
  export function bigIntToU8Array(bigInt, byteLength = 32) {
    let hex = bigInt.toString(16); // Convert to hex
    if (hex.length % 2 !== 0) hex = "0" + hex; // Ensure even-length hex
    let bytes = Buffer.from(hex, "hex"); // Convert hex to buffer
  
    // Ensure the byte array is `byteLength` long (default 32 bytes)
    if (bytes.length < byteLength) {
      const paddedBytes = Buffer.alloc(byteLength); // Create zero-filled buffer
      bytes.copy(paddedBytes, byteLength - bytes.length); // Right-align bytes
      bytes = paddedBytes;
    }
  
    return Array.from(bytes); // Convert Buffer to an array of numbers (u8)
  }
  

  export function buildMerkleTree(leaves) {
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
        const merged = poseidon2([left, right]);
        nextLevel.push(merged);
        
      }
  
      tree.push(nextLevel);
      level++;
    }
    let size = tree.length;
    const rootHash = tree[size-1][0]
    console.log("Root hash from generated tree: ", rootHash);
    console.log("Root hash as byte array", bigIntToU8Array(rootHash))
  
    return tree;
  }
  
export function getMerkleProof(tree, leafIndex) {
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
  

  export function nextPowerOfTwo(n) {
    let T = 1;
    while (T < n) T *= 2;
    return T;
  }
/**
 * Returns true if n is a power of two.
 * @param {number} n 
 * @returns {boolean}
 */
function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Recursively pads an array of batches so that its length becomes a power of two.
 * The rule is:
 * - Convert the current length L to binary.
 * - Find the first '1' from the right (1-indexed position).
 * - Let X = 2^(position-1) be the number of batches to duplicate from the end.
 * - Append the last X batches.
 * Repeat until the length is a power of two.
 *
 * @param {Array<any>} batches - An array of batches.
 * @returns {Array<any>} - The padded array of batches.
 */
export function padBatchesRecursive(batches) {
  let result = batches.slice();
  while (!isPowerOfTwo(result.length)) {
    const L = result.length;
    const binStr = L.toString(2);
    // Find the first '1' from the right (1-indexed).
    let posFromRight = 0;
    for (let i = binStr.length - 1; i >= 0; i--) {
      posFromRight = binStr.length - i; // 1-indexed position
      if (binStr[i] === '1') break;
    }
    const duplicateCount = 2 ** (posFromRight - 1);
    console.log(`Current length: ${L} (${binStr}). First '1' from right is at position ${posFromRight}. Duplicating last ${duplicateCount} batches.`);
    const toDuplicate = result.slice(-duplicateCount);
    result = result.concat(toDuplicate);
    console.log(`New length: ${result.length} (${result.length.toString(2)})`);
  }
  return result;
}

export function padWithDefaultLeaves(leaves){
  const n = nextPowerOfTwo(leaves.length);
  console.log("Padding to ",n," leaves...");
  let i = leaves.length;
  while(i<n){
    leaves.push(BigInt(0));
    i++;
  }
  console.log("Padded leaves length:", leaves.length);
  return leaves;
}

function getDefaultRootDepth(depth) {
  let parentHash = BigInt(0); // Assuming DEFAULT_LEAF is defined as a constant

  for (let i = 0; i < depth; i++) {
      parentHash = poseidon2([parentHash, parentHash]);
      // console.log(`Depth ${i + 1} hash: ${parentHash.toString()}`);
  }

  return parentHash;
}
// Function to deepen the hash
export function deepen(wholeTreeRoot, currentDepth, wantedDepth) {
  let defaultHash = getDefaultRootDepth(currentDepth);
  let hashed = poseidon2([wholeTreeRoot, defaultHash]);

  for (let x = currentDepth + 1; x < wantedDepth; x++) {
      defaultHash = getDefaultRootDepth(x);
      hashed = poseidon2([hashed, defaultHash]);
      hashedArray = bigIntToU8Array(hashed);
      console.log("i: ", i," hashed array: ", hashedArray);
  }

  return hashed;
}
