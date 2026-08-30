import os
from pkg.sub.base import Base, make_base


def make():
    make_base()
    return Base()
