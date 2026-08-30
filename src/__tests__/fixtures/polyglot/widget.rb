class Widget < Base
  def render(x)
    helper(x)
  end

  def helper(x)
    x
  end
end
