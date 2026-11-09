export class Admission {
  private active = 0;
  private window = 0;
  private authorization = 0;
  private token = 0;
  private closing = false;
  constructor(private now = () => Date.now()) {}
  enter(route: string): { release: () => void } | undefined {
    const now = this.now();
    if (now - this.window >= 60000) {
      this.window = now;
      this.authorization = 0;
      this.token = 0;
    }
    if (
      this.closing ||
      this.active >= 32 ||
      (route === "/auth" && this.authorization >= 30) ||
      (route === "/token" && this.token >= 120)
    )
      return;
    if (route === "/auth") this.authorization++;
    if (route === "/token") this.token++;
    this.active++;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.active--;
        }
      },
    };
  }
  close() {
    this.closing = true;
  }
}
