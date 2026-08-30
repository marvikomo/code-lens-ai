import Foundation

protocol Drawer {
    func draw()
}

class Widget: Base {
    var field = 1

    func draw() {
        helper()
    }
}

func helper() {}
