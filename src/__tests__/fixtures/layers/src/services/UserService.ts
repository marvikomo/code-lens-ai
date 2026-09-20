import { findUser } from "../db/users";

export class UserService {
  async profile(id: string) {
    const user = await findUser(id);
    return user ? { name: user.name } : null;
  }

  private redact(value: string): string {
    return value.replace(/./g, "*");
  }
}
