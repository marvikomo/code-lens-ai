use std::io::Read;

pub struct Shape {
    n: i32,
}

pub trait Drawer {
    fn draw(&self);
}

impl Drawer for Shape {
    fn draw(&self) {
        helper();
    }
}

fn helper() {}
