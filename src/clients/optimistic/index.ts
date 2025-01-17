import { concatUint8Array, isUint8ArrayEq, smallHexStr } from '../../utils.js';
import { BaseClient } from '../base-client.js';
import { ClientConfig, ProverInfo } from '../types.js';
import { IProver } from './iprover.js';
import { DEFAULT_BATCH_SIZE } from '../constants.js';

export type ProverInfoL = {
  syncCommitteeHash: Uint8Array;
  index: number;
};

export class OptimisticLightClient extends BaseClient {
  batchSize: number;

  constructor(
    config: ClientConfig,
    beaconChainAPIURL: string,
    protected provers: IProver[],
  ) {
    super(config, beaconChainAPIURL);
    this.batchSize = config.n || DEFAULT_BATCH_SIZE;
  }

  async getCommittee(
    period: number,
    proverIndex: number,
    expectedCommitteeHash: Uint8Array | null,
  ): Promise<Uint8Array[]> {
    if (period === this.genesisPeriod) return this.genesisCommittee;
    if (!expectedCommitteeHash)
      throw new Error('expectedCommitteeHash required');
    const committee = await this.provers[proverIndex].getCommittee(period);
    const committeeHash = this.getCommitteeHash(committee);
    if (!isUint8ArrayEq(committeeHash, expectedCommitteeHash as Uint8Array))
      throw new Error('prover responded with an incorrect committee');
    return committee;
  }

  async checkCommitteeHashAt(
    proverIndex: number,
    expectedCommitteeHash: Uint8Array,
    period: number,
    prevCommittee: Uint8Array[],
  ): Promise<boolean> {
    const update = await this.provers[proverIndex].getSyncUpdate(period - 1);
    const validOrCommittee = this.syncUpdateVerifyGetCommittee(
      prevCommittee,
      update,
    );
    if (!(validOrCommittee as boolean)) return false;
    const committeeHash = this.getCommitteeHash(
      validOrCommittee as Uint8Array[],
    );
    return isUint8ArrayEq(committeeHash, expectedCommitteeHash);
  }

  async fight(
    proverInfo1: ProverInfoL,
    proverInfo2: ProverInfoL,
    period: number,
    prevCommitteeHash: Uint8Array,
  ): Promise<boolean> {
    const prevCommittee =
      period === this.genesisPeriod
        ? this.genesisCommittee
        : await this.getCommittee(
            period - 1,
            proverInfo1.index,
            prevCommitteeHash,
          );
    const is1Correct = await this.checkCommitteeHashAt(
      proverInfo1.index,
      proverInfo1.syncCommitteeHash,
      period,
      prevCommittee,
    );
    const is2Correct = await this.checkCommitteeHashAt(
      proverInfo2.index,
      proverInfo2.syncCommitteeHash,
      period,
      prevCommittee,
    );

    if (is1Correct && !is2Correct) return true;
    else if (is2Correct && !is1Correct) return false;
    else if (!is2Correct && !is1Correct) {
      // If both of them are correct we can return either
      // true or false. The one honest prover will defeat
      // this prover later
      return false;
    } else throw new Error('both updates can not be correct at the same time');
  }

  async tournament(
    proverInfos: ProverInfoL[],
    period: number,
    lastCommitteeHash: Uint8Array,
  ) {
    let winners = [proverInfos[0]];
    for (let i = 1; i < proverInfos.length; i++) {
      // Consider one of the winner for thi current round
      const currWinner = winners[0];
      const currProver = proverInfos[i];
      if (
        isUint8ArrayEq(
          currWinner.syncCommitteeHash,
          currProver.syncCommitteeHash,
        )
      ) {
        // if the prover has the same syncCommitteeHash as the current
        // winners simply add it to list of winners
        console.log(
          `Prover(${currProver.index}) added to the existing winners list`,
        );
        winners.push(currProver);
      } else {
        console.log(
          `Fight between Prover(${currWinner.index}) and Prover(${currProver.index})`,
        );
        const areCurrentWinnersHonest = await this.fight(
          currWinner,
          currProver,
          period,
          lastCommitteeHash,
        );
        // If the winner lost discard all the existing winners
        if (!areCurrentWinnersHonest) {
          console.log(
            `Prover(${currProver.index}) defeated all existing winners`,
          );
          winners = [currProver];
        }
      }
    }
    return winners;
  }

  // returns the prover info containing the current sync
  // committee and prover index of the first honest prover
  protected async syncFromGenesis(): Promise<ProverInfo[]> {
    // get the tree size by currentPeriod - genesisPeriod
    const currentPeriod = this.getCurrentPeriod();
    let startPeriod = this.genesisPeriod;
    console.log(
      `Sync started using ${this.provers.length} Provers from period(${startPeriod}) to period(${currentPeriod})`,
    );

    let lastCommitteeHash: Uint8Array = this.getCommitteeHash(
      this.genesisCommittee,
    );
    let proverInfos: ProverInfoL[] = this.provers.map((_, i) => ({
      index: i,
      syncCommitteeHash: new Uint8Array(),
    }));

    for (let period = startPeriod + 1; period <= currentPeriod; period++) {
      const committeeHashes: Uint8Array[] = await Promise.all(
        proverInfos.map(pi =>
          this.provers[pi.index].getCommitteeHash(
            period,
            currentPeriod,
            this.batchSize,
          ),
        ),
      );

      let foundConflict = false;
      for (let j = 0; j < committeeHashes.length; j++) {
        if (!isUint8ArrayEq(committeeHashes[j], committeeHashes[0])) {
          foundConflict = true;
          break;
        }
      }

      proverInfos = proverInfos.map((pi, i) => ({
        ...pi,
        syncCommitteeHash: committeeHashes[i],
      }));

      if (foundConflict) {
        proverInfos = await this.tournament(
          proverInfos,
          period,
          lastCommitteeHash,
        );
        if (proverInfos.length < 2) break;
      }
      lastCommitteeHash = proverInfos[0].syncCommitteeHash;
    }

    for (const p of proverInfos) {
      try {
        const committee = await this.getCommittee(
          currentPeriod,
          p.index,
          lastCommitteeHash,
        );
        return [
          {
            index: p.index,
            syncCommittee: committee,
          },
        ];
      } catch (e) {
        console.error(
          `seemingly honest prover(${p.index}) responded incorrectly!`,
        );
      }
    }
    throw new Error('none of the provers responded honestly :(');
  }
}
