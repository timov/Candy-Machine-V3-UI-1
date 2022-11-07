import { CandyMachine, Metaplex } from "@metaplex-foundation/js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { MintCounterBorsh } from "../borsh/mintCounter";
import {
  GuardGroup,
  GuardGroupStates,
  MintLimitLogics,
  ParsedPricesForUI,
  Token,
  TokenPayment$Gate,
} from "./types";
import {
  DefaultCandyGuardSettings,
  Metadata,
  SplTokenCurrency,
} from "@metaplex-foundation/js";
let i = 0;
export const guardToPaymentUtil = (guards: GuardGroup): ParsedPricesForUI => {
  const paymentsRequired: ParsedPricesForUI = {
    payment: [],
    gate: [],
    burn: [],
  };
  if (!guards) return paymentsRequired;
  // console.log("guardToPaymentUtil", { guards });
  const actions: ("payment" | "burn" | "gate")[] = ["payment", "burn", "gate"];
  if (actions.find((action) => guards[action])) {
    if (guards.payment?.sol) {
      paymentsRequired.payment.push({
        label: "SOL",
        price: guards.payment.sol.amount / 10 ** LAMPORTS_PER_SOL,
        kind: "sol",
      });
    }

    for (let action of actions) {
      if (guards[action]?.token) {
        paymentsRequired[action].push({
          label: guards[action].token.symbol || "Token",
          price:
            guards[action].token.amount / 10 ** guards[action].token.decimals,
          decimals: guards[action].token.decimals,
          mint: guards[action].token.mint,
          kind: "token",
        });
      }
      if (guards[action]?.nfts?.length) {
        paymentsRequired[action].push({
          label: guards[action].nfts[0].symbol || "NFT",
          mint: guards[action].nfts[0].collection.address,
          price: 1,
          kind: "nft",
        });
      }
    }
  }
  return paymentsRequired;
};

export const mintLimitCaches: { [k: string]: Promise<MintLimitLogics> } = {};

export const fetchMintLimit = (
  mx: Metaplex,
  candyMachine: CandyMachine,
  guardsInput$mintLimit,
  rerenderer?: () => void
): Promise<MintLimitLogics> => {
  const cacheKey = `${
    guardsInput$mintLimit.id
  }-${candyMachine.candyGuard.address.toString()}-${mx
    .identity()
    .publicKey.toString()}`;
  if (!mintLimitCaches[cacheKey]) {
    mintLimitCaches[cacheKey] = (async () => {
      const mintLimit: MintLimitLogics = {
        settings: guardsInput$mintLimit,
      };
      if (!mintLimit.pda)
        mintLimit.pda = await mx.candyMachines().pdas().mintLimitCounter({
          candyGuard: candyMachine.candyGuard.address,
          id: guardsInput$mintLimit.id,
          candyMachine: candyMachine.address,
          user: mx.identity().publicKey,
        });
      if (mintLimit.pda) {
        mintLimit.accountInfo = await mx.connection.getAccountInfo(
          mintLimit.pda
        );
        if (mintLimit.accountInfo)
          mintLimit.mintCounter = MintCounterBorsh.fromBuffer(
            mintLimit.accountInfo.data
          );
      }
      if (rerenderer) setTimeout(() => rerenderer(), 100);

      return mintLimit;
    })();
  }
  return mintLimitCaches[cacheKey];
};

export const mergeGuards = (guardsArray: DefaultCandyGuardSettings[]) => {
  const guards: DefaultCandyGuardSettings = guardsArray.reduce(
    (acc, guards) => {
      acc = { ...acc };
      Object.entries(guards).forEach(([key, guard]) => {
        if (guard) acc[key] = guard;
      });
      return acc;
    } //,
    //{} as DefaultCandyGuardSettings
  );
  //   console.log({ guards });
  return guards;
};

export const parseGuardGroup = async (
  {
    candyMachine,
    guards: guardsInput,
    label,
    walletAddress,
    nftHoldings,
    verifyProof,
  }: {
    guards: DefaultCandyGuardSettings;
    candyMachine: CandyMachine;
    walletAddress: PublicKey;
    label?: string;
    // allowLists: AllowLists;
    // tokenHoldings: Token[];
    nftHoldings: Metadata[];
    verifyProof: (merkleRoot: Uint8Array | string, label?: string) => boolean;
    // tokenHoldings, nftHoldings
  },
  mx?: Metaplex
): Promise<GuardGroup> => {
  const guardsParsed: GuardGroup = {};
  //   console.log(guardsInput);
  // Check for start date
  if (guardsInput.startDate) {
    const date = new Date(guardsInput.startDate.date.toNumber() * 1000);
    if (date.getTime() > Date.now()) {
      guardsParsed.startTime = date;
    } else {
      guardsParsed.startTime = null;
    }
  }

  // Check for end date
  if (guardsInput.endDate) {
    guardsParsed.endTime = new Date(guardsInput.endDate.date.toNumber() * 1000);
  }

  // Check for mint limit
  if (guardsInput.mintLimit) {
    guardsParsed.mintLimit = { settings: guardsInput.mintLimit };
    if (mx)
      await fetchMintLimit(mx, candyMachine, guardsInput.mintLimit)
        .then((mintLimit) => {
          guardsParsed.mintLimit = mintLimit;
        })
        .catch(console.error);
  }

  // Check for redeemed list
  if (guardsInput.redeemedAmount) {
    guardsParsed.redeemLimit = guardsInput.redeemedAmount.maximum.toNumber();
  }

  // Check for payment guards

  if (guardsInput.solPayment) {
    guardsParsed.payment = {
      sol: {
        amount: guardsInput.solPayment.amount.basisPoints.toNumber(),
        decimals: guardsInput.solPayment.amount.currency.decimals,
      },
    };
  }

  if (guardsInput.tokenPayment) {
    guardsParsed.payment = {
      token: {
        mint: guardsInput.tokenPayment.mint,
        symbol: guardsInput.tokenPayment.amount.currency.symbol,
        amount: guardsInput.tokenPayment.amount.basisPoints.toNumber(),
        decimals: guardsInput.tokenPayment.amount.currency.decimals,
      },
    };
    await updateTokenSymbolAndDecimalsFromChainAsync(
      mx,
      guardsParsed.payment.token
    );
  }
  if (guardsInput.nftPayment) {
    guardsParsed.payment = {
      nfts: nftHoldings.filter((y) =>
        y.collection?.address.equals(guardsInput.nftPayment.requiredCollection)
      ),
    };
  }

  // Check for burn guards

  if (guardsInput.tokenBurn) {
    guardsParsed.burn = {
      token: {
        mint: guardsInput.tokenBurn.mint,
        symbol: guardsInput.tokenBurn.amount.currency.symbol,
        amount: guardsInput.tokenBurn.amount.basisPoints.toNumber(),
        decimals: guardsInput.tokenBurn.amount.currency.decimals,
      },
    };
    await updateTokenSymbolAndDecimalsFromChainAsync(
      mx,
      guardsParsed.burn.token
    );
  }
  if (guardsInput.nftBurn) {
    guardsParsed.burn = {
      nfts: nftHoldings.filter((y) =>
        y.collection?.address.equals(guardsInput.nftBurn.requiredCollection)
      ),
    };
  }

  // Check for gates

  if (guardsInput.tokenGate) {
    guardsParsed.gate = {
      token: {
        mint: guardsInput.tokenGate.mint,
        symbol: guardsInput.tokenGate.amount.currency.symbol,
        amount: guardsInput.tokenGate.amount.basisPoints.toNumber(),
        decimals: guardsInput.tokenGate.amount.currency.decimals,
      },
    };
    await updateTokenSymbolAndDecimalsFromChainAsync(
      mx,
      guardsParsed.gate.token
    );
  }
  if (guardsInput.nftGate) {
    guardsParsed.gate = {
      nfts: nftHoldings.filter((y) =>
        y.collection?.address.equals(guardsInput.nftGate.requiredCollection)
      ),
    };
  }

  // Check for whitelisted addresses

  if (guardsInput.addressGate || guardsInput.allowList) {
    let allowed: PublicKey[] = [];
    if (guardsInput.addressGate) allowed.push(guardsInput.addressGate.address);

    if (guardsInput.allowList?.merkleRoot) {
      const isValid = verifyProof(
        guardsInput.allowList.merkleRoot,
        label || "default"
      );
      if (isValid) allowed.push(walletAddress);
    }

    guardsParsed.allowed = allowed;
  }

  if (guardsInput.gatekeeper) {
    guardsParsed.gatekeeperNetwork = guardsInput.gatekeeper.network;
  }

  return guardsParsed;
};

export const parseGuardStates = ({
  guards,
  candyMachine,
  walletAddress,
  tokenHoldings,
  balance,
}: {
  guards: GuardGroup;
  candyMachine: CandyMachine;
  walletAddress: PublicKey;
  tokenHoldings: Token[];
  balance: number;
}): GuardGroupStates => {
  const states: GuardGroupStates = {
    isStarted: true,
    isEnded: false,
    isLimitReached: false,
    isPaymentAvailable: true,
    isWalletWhitelisted: true,
    hasGatekeeper: false,
  };
  // if (guards.payment?.nfts?.length) debugger;
  // Check for start date
  if (guards.startTime) {
    states.isStarted = guards.startTime.getTime() < Date.now();
  }
  // Check for start date
  if (guards.endTime) {
    states.isEnded = guards.endTime.getTime() < Date.now();
  }

  // Check for mint limit
  if (guards.mintLimit) {
    states.isLimitReached = guards.mintLimit?.mintCounter?.count
      ? !(
          guards.mintLimit?.settings?.limit <
          guards.mintLimit?.mintCounter?.count
        )
      : false;
  }

  // Check for redeemed list
  if (guards.redeemLimit) {
    states.isLimitReached =
      guards.redeemLimit >= candyMachine.itemsMinted.toNumber();
  }

  // Check for payment guards

  if (guards.payment?.sol) {
    states.isPaymentAvailable =
      states.isPaymentAvailable && guards.payment?.sol.amount <= balance;
  }
  if (guards.payment?.token) {
    const tokenAccount = tokenHoldings.find((x) =>
      x.mint.equals(guards.payment?.token.mint)
    );
    states.isPaymentAvailable =
      states.isPaymentAvailable &&
      !!tokenAccount &&
      guards.payment?.token.amount <= tokenAccount.balance;
  }

  if (guards.payment?.nfts) {
    states.isPaymentAvailable =
      states.isPaymentAvailable && !!guards.payment?.nfts.length;
  }

  // Check for burn guards
  if (guards.burn?.token) {
    const tokenAccount = tokenHoldings.find((x) =>
      x.mint.equals(guards.burn?.token.mint)
    );
    states.isPaymentAvailable =
      states.isPaymentAvailable &&
      !!tokenAccount &&
      guards.burn?.token.amount <= tokenAccount.balance;
  }

  if (guards.burn?.nfts) {
    states.isPaymentAvailable =
      states.isPaymentAvailable && !!guards.burn?.nfts.length;
  }

  // Check for gates
  if (guards.gate?.token) {
    const tokenAccount = tokenHoldings.find((x) =>
      x.mint.equals(guards.gate?.token.mint)
    );
    states.isPaymentAvailable =
      states.isPaymentAvailable &&
      !!tokenAccount &&
      guards.gate?.token.amount <= tokenAccount.balance;
  }

  if (guards.gate?.nfts) {
    states.isPaymentAvailable =
      states.isPaymentAvailable && !!guards.gate?.nfts.length;
  }

  // Check for whitelisted addresses
  if (guards.allowed) {
    states.isWalletWhitelisted = !!guards.allowed.find((x) =>
      x.equals(walletAddress)
    );
  }

  if (guards.gatekeeperNetwork) {
    states.hasGatekeeper = true;
  }

  return states;
};
export const tokenSymbolCaches: {
  [k: string]: Promise<void | SplTokenCurrency>;
} = {};

export const updateTokenSymbolAndDecimalsFromChainAsync = async (
  mx: Metaplex,
  token: TokenPayment$Gate
) => {
  const chacheKey = token.mint.toString();
  if (!tokenSymbolCaches[chacheKey]) {
    tokenSymbolCaches[chacheKey] = mx
      .tokens()
      .findMintByAddress({ address: token.mint })
      .then((mint) => mint.currency)
      .catch(() => {
        delete tokenSymbolCaches[chacheKey];
      });
  }
  const res = await tokenSymbolCaches[chacheKey];
  if (res) {
    token.decimals = res.decimals;
    token.symbol = res.symbol;
  }
};