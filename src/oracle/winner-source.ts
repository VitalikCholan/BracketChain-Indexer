export interface WinnerSource {
  resolveWinner(
    steamIdA: string,
    steamIdB: string,
    committedAtUnix: number,
  ): Promise<0 | 1 | null>;
}
