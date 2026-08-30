import app.Base

trait Drawer {
  def draw(): Unit
}

class Widget extends Base {
  val field = 1

  def draw(): Unit = {
    helper()
  }
}
