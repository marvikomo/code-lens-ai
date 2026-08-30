using System;

namespace App {
  interface IDraw { void Draw(); }

  class Widget : Base {
    private int field;

    public void Draw() {
      Helper();
      this.Decorate();
    }
  }
}
