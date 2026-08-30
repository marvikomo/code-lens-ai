<?php
namespace App;

use App\Base;

interface IDraw {
    public function draw();
}

class Widget extends Base implements IDraw {
    private $field;

    public function draw() {
        helper();
        $this->decorate();
    }
}

function helper() {}
