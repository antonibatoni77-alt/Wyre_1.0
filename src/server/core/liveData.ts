export class LiveData<T> {
  constructor(
    private readonly options: {
      fetch: () => Promise<T> | T;
      watch?: (context: { publish: () => void }) => (() => void) | void;
    },
  ) {}

  fetch() {
    return this.options.fetch();
  }
}

export function isLiveData(value: unknown): value is LiveData<unknown> {
  return value instanceof LiveData;
}
