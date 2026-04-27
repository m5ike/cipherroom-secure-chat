export interface IStorage {
  readonly persistence: "none";
}

export const storage: IStorage = { persistence: "none" };
