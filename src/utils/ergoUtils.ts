import * as ergo from 'ergo-lib-wasm-nodejs';

export function getAddressFromMnemonic(mnemonic: string, mnemonicpass: string): string {
    const seed = ergo.Mnemonic.to_seed(mnemonic, mnemonicpass);
    const extendedSecretKey = ergo.ExtSecretKey.derive_master(seed);
    
    // derive the initial secret key, this is the change key and is also the owner of the boxes used as inputs
    const changePath = ergo.DerivationPath.from_string("m/44'/429'/0'/0/0");
    const changeSk = extendedSecretKey.derive(changePath);
    const dlogSecret = ergo.SecretKey.dlog_from_bytes(changeSk.secret_key_bytes());
    
    // Get address directly from the secret key
    const address = dlogSecret.get_address();
    return address.to_base58(ergo.NetworkPrefix.Mainnet);
}

export function createWallet(mnemonics: string, mpass: string): any {
    const seed = ergo.Mnemonic.to_seed(mnemonics, mpass);

    // derive the root extended key/secret
    const extendedSecretKey = ergo.ExtSecretKey.derive_master(seed);

    const secretKeys = new ergo.SecretKeys();

    // For now, assume IS_24 is false - you can add this as a parameter later
    const IS_24 = false;

    if (IS_24) {
        let sk = ergo.SecretKey.from_bytes(extendedSecretKey.secret_key_bytes());
        secretKeys.add(sk);
    } else {
        // derive the initial secret key, this is the change key and is also the owner of the boxes used as inputs
        const changePath = ergo.DerivationPath.from_string("m/44'/429'/0'/0/0");
        const changeSk = extendedSecretKey.derive(changePath);

        const dlogSecret = ergo.SecretKey.dlog_from_bytes(changeSk.secret_key_bytes());

        secretKeys.add(dlogSecret);
    }

    const wallet = ergo.Wallet.from_secrets(secretKeys);

    return wallet;
}