pragma circom 2.0.0;

include "./circomlib/circuits/switcher.circom";
include "./circomlib/circuits/poseidon.circom";
include "./circomlib/circuits/bitify.circom";

template Mkt2VerifierLevel() {
    signal input sibling;
    signal input low;
    signal input selector;
    signal output root;

    component sw = Switcher();
    component hash = Poseidon(2);

    sw.sel <== selector;
    sw.L <== low;
    sw.R <== sibling;

    log(sw.outL);
    log(sw.outR);

    hash.inputs[0] <== sw.outL;
    hash.inputs[1] <== sw.outR;

    root <== hash.out;
}

template Mkt2Verifier(nLevels) {

    signal input key;
    signal input secret;
    signal input nullifier;
    signal input nullifierHash;
    signal input root;
    signal input siblings[nLevels];

    component hashV = Poseidon(2);
    hashV.inputs[0] <== secret;
    hashV.inputs[1] <== nullifier;

    component hashNullifier = Poseidon(1);
    hashNullifier.inputs[0] <== nullifier;

    component n2b = Num2Bits(nLevels);
    component levels[nLevels];

    n2b.in <== key;

    for (var i=nLevels-1; i>=0; i--) {
        levels[i] = Mkt2VerifierLevel();
        levels[i].sibling <== siblings[i];
        // levels[i].selector <== n2b.out[i];
        levels[i].selector <== n2b.out[nLevels - 1 - i];
        if (i==nLevels-1) {
            levels[i].low <== hashV.out;
        }
        else {
            levels[i].low <== levels[i+1].root;
        }
        log("i: ",i);
        log("siblings[i]",siblings[i]);
    }

    log(levels[0].root);
    log(root);
    
    root === levels[0].root;
    hashNullifier.out === nullifierHash;
}

component main { public [root, nullifierHash] } = Mkt2Verifier(8);


