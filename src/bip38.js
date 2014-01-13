Bitcoin.BIP38 = (function () {

  var BIP38 = function() {};


  /**
   * Standard bitcoin curve - secp256k1
   */
  var ecparams = getSECCurveByName("secp256k1");

  /**
   * Random number generator
   */
  var rng = new SecureRandom();

  /**
   * Default parameters for scrypt key derivation
   *  -> N: cpu cost
   *  -> r: memory cost
   *  -> p: parallelization cost
   */
  var scryptParams = {
    passphrase: { N: 16384, r: 8, p: 8 },        // Way too slow (especially on IE), but recommended values
    passphraseFast: { N: 2048, r: 4, p: 4 },
    passpoint: { N: 1024, r: 1, p: 1 }
  };

  /**
   * Default parameters for AES
   */
  var AES_opts = {mode: new Crypto.mode.ECB(Crypto.pad.NoPadding), asBytes: true};



  /**
   * Private key encoded per BIP-38 (password encrypted, checksum,  base58)
   * @author scintill
   */
  BIP38.encode = function (eckey, passphrase) {
    var privKeyBytes = eckey.getPrivateKeyByteArray();
    var address = eckey.getBitcoinAddress().toString();
  
    // compute sha256(sha256(address)) and take first 4 bytes
    var salt = Bitcoin.Util.dsha256(address).slice(0, 4);
  
    // derive key using scrypt
    var derivedBytes = Bitcoin.scrypt(passphrase, salt, scryptParams.passphraseFast.N, scryptParams.passphraseFast.r, scryptParams.passphraseFast.p, 64);
    for(var i = 0; i < 32; ++i) {
      privKeyBytes[i] ^= derivedBytes[i];
    }
  
    // 0x01 0x42 + flagbyte + salt + encryptedhalf1 + encryptedhalf2
    var flagByte = eckey.compressed ? 0xe0 : 0xc0;
    var encryptedKey = [ 0x01, 0x42, flagByte ].concat(salt);

    var encryptedKey = encryptedKey.concat(Crypto.AES.encrypt(privKeyBytes, derivedBytes.slice(32), AES_opts));
  
    encryptedKey = encryptedKey.concat(Bitcoin.Util.dsha256(encryptedKey).slice(0,4));

    return Bitcoin.Base58.encode(encryptedKey);
  }

  /**
   * Parse a wallet import format private key contained in a string.
   * @author scintill
   */
  BIP38.decode = function (base58Encrypted, passphrase) {
    var hex;
    try {
      hex = Bitcoin.Base58.decode(base58Encrypted);
    } catch (e) {
      throw new Error("Invalid BIP38-encrypted private key. Unable to decode base58.");
    }
  
    if (hex.length != 43) {
      throw new Error("Invalid BIP38-encrypted private key. Length of key in hex format is not 43 characters in length.");
    } else if (hex[0] != 0x01) {
      throw new Error("Invalid BIP38-encrypted private key. First byte is not 0x01.");
    }
  
    var expChecksum = hex.slice(-4);
    hex = hex.slice(0, -4);
  
    var checksum = Bitcoin.Util.dsha256(hex);
    if (checksum[0] != expChecksum[0] || checksum[1] != expChecksum[1] || checksum[2] != expChecksum[2] || checksum[3] != expChecksum[3]) {
      throw new Error("Invalid BIP38-encrypted private key. Checksum failed.");
    }
  
    var isCompPoint = false;
    var isECMult = false;
    var hasLotSeq = false;
    if (hex[1] == 0x42) {
      if (hex[2] == 0xe0) {
        isCompPoint = true;
      } else if (hex[2] != 0xc0) {
        throw new Error("Invalid BIP38-encrypted private key. Second byte should be 0xc0.");
      }
    } else if (hex[1] == 0x43) {
      isECMult = true;
      isCompPoint = (hex[2] & 0x20) != 0;
      hasLotSeq = (hex[2] & 0x04) != 0;
      if ((hex[2] & 0x24) != hex[2]) {
        throw new Error("Invalid BIP38-encrypted private key. Unknown validation error.");
      }
    } else {
      throw new Error("Invalid BIP38-encrypted private key. Unknown validation error.");
    }
  
    var decrypted;
    var verifyHashAndReturn = function() {
      var tmpkey = new Bitcoin.ECKey(decrypted);
      tmpkey.setCompressed(isCompPoint);
      
      var address = tmpkey.getBitcoinAddress();
      checksum = Bitcoin.Util.dsha256(address.toString());
  
      if (checksum[0] != hex[3] || checksum[1] != hex[4] || checksum[2] != hex[5] || checksum[3] != hex[6]) {
        throw new Error("Invalid BIP38-encrypted private key. Hash could not be verified.");
      }
  
      return tmpkey;
    };
  
    if (!isECMult) {
      var addresshash = hex.slice(3, 7);
      var derivedBytes = Bitcoin.scrypt(passphrase, addresshash, scryptParams.passphraseFast.N, scryptParams.passphraseFast.r, scryptParams.passphraseFast.p, 64);
      var k = derivedBytes.slice(32, 32+32);
      decrypted = Crypto.AES.decrypt(hex.slice(7, 7+32), k, AES_opts);
      for (var x = 0; x < 32; x++) decrypted[x] ^= derivedBytes[x];
      return verifyHashAndReturn();
    } else {
      var ownerentropy = hex.slice(7, 7+8);
      var ownersalt = !hasLotSeq ? ownerentropy : ownerentropy.slice(0, 4);
      var prefactorA = Bitcoin.scrypt(passphrase, ownersalt, scryptParams.passphraseFast.N, scryptParams.passphraseFast.r, scryptParams.passphraseFast.p, 32);
      var passfactor;
      if (!hasLotSeq) {
        passfactor = prefactorA;
      } else {
        var prefactorB = prefactorA.concat(ownerentropy);
        passfactor = Bitcoin.Util.dsha256(prefactorB);
      }
      var kp = new Bitcoin.ECKey(passfactor);
      kp.compressed = true;
      var passpoint = kp.getPub();
  
      var encryptedPart2 = hex.slice(23, 23+16);
  
      var addressHashPlusOnwerEntropy = hex.slice(3, 3+12);
      var derived = Bitcoin.scrypt(passpoint, addressHashPlusOnwerEntropy, scryptParams.passpoint.N, scryptParams.passpoint.r, scryptParams.passpoint.p, 64);
      var k = derived.slice(32);
  
      var unencryptedPart2 = Crypto.AES.decrypt(encryptedPart2, k, AES_opts);
      for (var i = 0; i < 16; i++) { unencryptedPart2[i] ^= derived[i+16]; }
  
      var encryptedpart1 = hex.slice(15, 15+8).concat(unencryptedPart2.slice(0, 0+8));
      var unencryptedpart1 = Crypto.AES.decrypt(encryptedpart1, k, AES_opts);
      for (var i = 0; i < 16; i++) { unencryptedpart1[i] ^= derived[i]; }
  
      var seedb = unencryptedpart1.slice(0, 0+16).concat(unencryptedPart2.slice(8, 8+8));
  
      var factorb = Bitcoin.Util.dsha256(seedb);
  
      var privateKey = BigInteger.fromByteArrayUnsigned(passfactor).multiply(BigInteger.fromByteArrayUnsigned(factorb)).remainder(ecparams.getN());
  
      decrypted = privateKey.toByteArrayUnsigned();
      return verifyHashAndReturn();
    }
  }

  /**
   * Generates an intermediate point based on a password which can later be used
   * to directly generate new BIP38-encrypted private keys without actually knowing
   * the password.
   * @author Zeilap
   */
  BIP38.generateIntermediate = function(passphrase, lotNum, sequenceNum) {
    var noNumbers = lotNum == null || sequenceNum == null;
    var ownerEntropy, ownerSalt;

    if(noNumbers) {
      ownerSalt = ownerEntropy = new Array(8);
      rng.nextBytes(ownerEntropy);
    } else {
      // 1) generate 4 random bytes
      var ownerSalt = Array(4);

      rng.nextBytes(ownerSalt);

      // 2)  Encode the lot and sequence numbers as a 4 byte quantity (big-endian):
      // lotnumber * 4096 + sequencenumber. Call these four bytes lotsequence.
      var lotSequence = nbv(4096*lotNum + sequenceNum).toByteArrayUnsigned();

      // 3) Concatenate ownersalt + lotsequence and call this ownerentropy.
      var ownerEntropy = ownerSalt.concat(lotSequence);
    }

    // 4) Derive a key from the passphrase using scrypt
    var prefactor = Bitcoin.scrypt(passphrase, ownerSalt, scryptParams.passphraseFast.N, scryptParams.passphraseFast.r, scryptParams.passphraseFast.p, 32);
 
    // Take SHA256(SHA256(prefactor + ownerentropy)) and call this passfactor
    var passfactorBytes = noNumbers? prefactor : Bitcoin.Util.dsha256(prefactor.concat(ownerEntropy));
    var passfactor = BigInteger.fromByteArrayUnsigned(passfactorBytes);

    // 5) Compute the elliptic curve point G * passfactor, and convert the result to compressed notation (33 bytes)
    var passpoint = ecparams.getG().multiply(passfactor).getEncoded(1);

    // 6) Convey ownersalt and passpoint to the party generating the keys, along with a checksum to ensure integrity.
    // magic bytes "2C E9 B3 E1 FF 39 E2 51" followed by ownerentropy, and then passpoint
    var magicBytes = [0x2C, 0xE9, 0xB3, 0xE1, 0xFF, 0x39, 0xE2, 0x51];
    if(noNumbers) magicBytes[7] = 0x53;

    var intermediatePreChecksum = magicBytes.concat(ownerEntropy).concat(passpoint);
    var intermediateBytes = intermediatePreChecksum.concat(Bitcoin.Util.dsha256(intermediatePreChecksum).slice(0,4));
    var intermediate = Bitcoin.Base58.encode(intermediateBytes);

    return intermediate;
  };

  /**
   * Creates new private key using an intermediate EC point.
   */
  BIP38.newAddressFromIntermediate = function(intermediate, compressed) {
    // validate intermediate code
    if (!BIP38.verifyIntermediate(intermediate)) {
      throw new Error("Invalid intermediate passphrase string");
    }

    // decode IPS
    var intermediateBytes = Bitcoin.Base58.decode(intermediate);
    var noNumbers = (intermediateBytes[7] === 0x53);
    var ownerEntropy = intermediateBytes.slice(8, 8+8);
    var passpoint = intermediateBytes.slice(16, 16+33);

    // 1) Set flagbyte.
    // set bit 0x20 for compressed key
    // set bit 0x04 if ownerentropy contains a value for lotsequence
    var flagByte = (compressed? 0x20 : 0x00) | (noNumbers? 0x00 : 0x04);

    // 2) Generate 24 random bytes, call this seedb.
    var seedB = new Array(24);
    rng.nextBytes(seedB);

    // Take SHA256(SHA256(seedb)) to yield 32 bytes, call this factorb.
    var factorB = Bitcoin.Util.dsha256(seedB);

    // 3) ECMultiply passpoint by factorb. Use the resulting EC point as a public key and hash it into a Bitcoin
    // address using either compressed or uncompressed public key methodology (specify which methodology is used
    // inside flagbyte). This is the generated Bitcoin address, call it generatedAddress.
    var ec = ecparams.getCurve();
    var generatedPoint = ec.decodePointHex(Crypto.util.bytesToHex(passpoint));
    var generatedBytes = generatedPoint.multiply(BigInteger.fromByteArrayUnsigned(factorB)).getEncoded(compressed);
    var generatedAddress = new Bitcoin.Address(Bitcoin.Util.sha256ripe160(generatedBytes));

    // 4) Take the first four bytes of SHA256(SHA256(generatedaddress)) and call it addresshash.
    var addressHash = Bitcoin.Util.dsha256(generatedAddress.toString()).slice(0,4);

    // 5) Now we will encrypt seedb. Derive a second key from passpoint using scrypt
    var derivedBytes = Bitcoin.scrypt(passpoint, addressHash.concat(ownerEntropy), scryptParams.passpoint.N, scryptParams.passpoint.r, scryptParams.passpoint.p, 64);

    // 6) Do AES256Encrypt(seedb[0...15]] xor derivedhalf1[0...15], derivedhalf2), call the 16-byte result encryptedpart1
    for(var i = 0; i < 16; ++i) {
      seedB[i] ^= derivedBytes[i];
    }
    var encryptedPart1 = Crypto.AES.encrypt(seedB.slice(0,16), derivedBytes.slice(32), AES_opts);

    // 7) Do AES256Encrypt((encryptedpart1[8...15] + seedb[16...23]) xor derivedhalf1[16...31], derivedhalf2), call the 16-byte result encryptedseedb.
    var message2 = encryptedPart1.slice(8, 8+8).concat(seedB.slice(16, 16+8));
    for(var i = 0; i < 16; ++i) {
      message2[i] ^= derivedBytes[i+16];
    }
    var encryptedSeedB = Crypto.AES.encrypt(message2, derivedBytes.slice(32), AES_opts);

    // 0x01 0x43 + flagbyte + addresshash + ownerentropy + encryptedpart1[0...7] + encryptedPart2
    var encryptedKey = [ 0x01, 0x43, flagByte ].concat(addressHash).concat(ownerEntropy).concat(encryptedPart1.slice(0,8)).concat(encryptedSeedB);

    // base58check encode
    encryptedKey = encryptedKey.concat(Bitcoin.Util.dsha256(encryptedKey).slice(0,4));

    // Generate confirmation code for the new address
    var confirmation = newAddressConfirmation(addressHash, factorB, derivedBytes, flagByte, ownerEntropy);

    return { address: generatedAddress,
             bip38PrivateKey: Bitcoin.Base58.encode(encryptedKey),
             confirmation: confirmation };
  };

  /**
   * Generates a confirmation code for a key/address generated using an intermediate
   * ec point (see BIP38.newAddressFromIntermediate).  This certifies that the address
   * truly corresponds to the password from which the intermediate ec point was derived
   * (see BIP38.verifyNewAddressConfirmation).
   */
  var newAddressConfirmation = function(addressHash, factorB, derivedBytes, flagByte, ownerEntropy) {
    // 1) ECMultiply factorb by G, call the result pointb. The result is 33 bytes.
    var pointb = ecparams.getG().multiply(BigInteger.fromByteArrayUnsigned(factorB)).getEncoded(1);

    // 2) he first byte is 0x02 or 0x03. XOR it by (derivedhalf2[31] & 0x01), call the resulting byte pointbprefix.
    var pointbprefix = pointb[0] ^ (derivedBytes[63] & 0x01);

    // 3) Do AES256Encrypt(pointb[1...16] xor derivedhalf1[0...15], derivedhalf2) and call the result pointbx1.
    for(var i = 0; i < 16; ++i) {
      pointb[i + 1] ^= derivedBytes[i];
    }
    var pointbx1 = Crypto.AES.encrypt(pointb.slice(1,17), derivedBytes.slice(32), AES_opts);
                        
    // 4) Do AES256Encrypt(pointb[17...32] xor derivedhalf1[16...31], derivedhalf2) and call the result pointbx2.
    for(var i = 16; i < 32; ++i) {
      pointb[i + 1] ^= derivedBytes[i];
    }
    var pointbx2 = Crypto.AES.encrypt(pointb.slice(17,33), derivedBytes.slice(32), AES_opts);

    var encryptedpointb = [ pointbprefix ].concat(pointbx1).concat(pointbx2);

    var confirmationPreChecksum =
      [ 0x64, 0x3B, 0xF6, 0xA8, 0x9A, flagByte ]
        .concat(addressHash)
        .concat(ownerEntropy)
        .concat(encryptedpointb);
    var confirmationBytes = confirmationPreChecksum.concat(Bitcoin.Util.dsha256(confirmationPreChecksum).slice(0,4));
    var confirmation = Bitcoin.Base58.encode(confirmationBytes);

    return confirmation;
  };

  /**
   * Certifies that the given address was generated using an intermediate ec point derived
   * from the given password (see BIP38.newAddressFromIntermediate).
   */
  BIP38.verifyNewAddressConfirmation = function(expectedAddressStr, confirmation, passphrase) {
    var confirmationResults = BIP38.verifyConfirmation(confirmation, passphrase);
    return (confirmationResults.address == expectedAddressStr);
  };

  /**
   * Certifies that the given BIP38 confirmation code matches the password and
   * returns the address the confirmation corresponds to (see BIP38.newAddressFromIntermediate).
   */
  BIP38.verifyConfirmation = function(confirmation, passphrase) {
    var bytes = Bitcoin.Base58.decode(confirmation);
                
    // Get the flag byte (tells us whether address compression is used and whether lot/sequence values are present).
    var flagByte = bytes[5];
                
    // Get the address hash.
    var addressHash = bytes.slice(6, 10);

    // Get the owner entropy (tells us the lot/sequence values when applicable).
    var ownerEntropy = bytes.slice(10, 18);

    // Get encryptedpointb
    var encryptedpointb = bytes.slice(18, 51);

    var compressed = (flagByte & 0x20) == 0x20;
    var lotSequencePresent = (flagByte & 0x04) == 0x04;
    var ownerSalt = ownerEntropy.slice(0, lotSequencePresent ? 4 : 8)

    var prefactor = Bitcoin.scrypt(passphrase, ownerSalt, scryptParams.passphraseFast.N, scryptParams.passphraseFast.r, scryptParams.passphraseFast.p, 32);

    // Take SHA256(SHA256(prefactor + ownerentropy)) and call this passfactor
    var passfactorBytes = !lotSequencePresent? prefactor : Bitcoin.Util.dsha256(prefactor.concat(ownerEntropy));
    var passfactor = BigInteger.fromByteArrayUnsigned(passfactorBytes);

    var passpoint = ecparams.getG().multiply(passfactor).getEncoded(1);

    var addresshashplusownerentropy = addressHash.concat(ownerEntropy);

    var derivedBytes = Bitcoin.scrypt(passpoint, addresshashplusownerentropy, scryptParams.passpoint.N, scryptParams.passpoint.r, scryptParams.passpoint.p, 64);

    // recover the 0x02 or 0x03 prefix
    var unencryptedpubkey = [];
    unencryptedpubkey[0] = encryptedpointb[0] ^ (derivedBytes[63] & 0x01);

    decrypted1 = Crypto.AES.decrypt(encryptedpointb.slice(1,17), derivedBytes.slice(32), AES_opts);
    decrypted2 = Crypto.AES.decrypt(encryptedpointb.slice(17,33), derivedBytes.slice(32), AES_opts);
    decrypted = unencryptedpubkey.concat(decrypted1).concat(decrypted2);

    for (var x = 0; x < 32; x++) { 
      decrypted[x+1] ^= derivedBytes[x];
    }

    var ec = ecparams.getCurve();
    var generatedPoint = ec.decodePointHex(Crypto.util.bytesToHex(decrypted).toString().toUpperCase());
    var generatedBytes = generatedPoint.multiply(BigInteger.fromByteArrayUnsigned(passfactor)).getEncoded(compressed);
    var generatedAddress = (new Bitcoin.Address(Bitcoin.Util.sha256ripe160(generatedBytes))).toString();

    var generatedAddressHash = Bitcoin.Util.dsha256(generatedAddress).slice(0,4);

    var valid = true;
    for (var i = 0; i < 4; i++) {
      if (addressHash[i] != generatedAddressHash[i]) {
        valid = false;
      }
    }
   
    return { valid: valid, address: generatedAddress };
  }

  /**
   * Checks the validity of an intermediate code.
   */
  BIP38.verifyIntermediate = function (intermediate) {
    // Simple regex check
    var regexValid = (/^passphrase[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(intermediate));
    if (!regexValid) return false;

    // Correct bytelen
    var intermediateBytes = Bitcoin.Base58.decode(intermediate);
    if (intermediateBytes.length != 53)  return false;

    // Checksum check
    var expectedChecksum = intermediateBytes.slice(49,53);
    var checksum = Bitcoin.Util.dsha256(intermediateBytes.slice(0, 49)).slice(0, 4);
    if (expectedChecksum[0] != checksum[0] ||
        expectedChecksum[1] != checksum[1] ||
        expectedChecksum[2] != checksum[2] ||
        expectedChecksum[3] != checksum[3]) {
          return false;
    }

    return true;
  }
 
  /**
   * Detects keys encrypted according to BIP-38 (58 base58 characters starting with 6P)
   */
  BIP38.isBIP38Format = function (string) {
    return (/^6P[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{56}$/.test(string));
  };


  return BIP38;

})();

