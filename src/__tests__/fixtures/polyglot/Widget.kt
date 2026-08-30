package app

import app.Base

class Widget : Base() {
    val field = 1

    fun render() {
        helper()
    }
}

fun helper() {}
