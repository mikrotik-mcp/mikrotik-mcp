/** Uniform 8-character passwords, conditioned on including all four character classes. */
export function generateUserPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-?";
  const limit = 256 - (256 % alphabet.length);
  const random = new Uint8Array(16);
  for (;;) {
    let password = "";
    while (password.length < 8) {
      crypto.getRandomValues(random);
      for (const value of random) {
        if (value < limit) password += alphabet[value % alphabet.length];
        if (password.length === 8) break;
      }
    }
    if (
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    )
      return password;
  }
}
