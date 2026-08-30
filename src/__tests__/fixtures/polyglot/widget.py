import os
from .base import Base

class Widget(Base):
    def render(self, x):
        helper(x)
        return self.decorate(x)

def helper(x):
    return len(x)
