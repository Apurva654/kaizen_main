import sys

def add_numbers(a: float, b: float) -> float:
    """Return the sum of two numbers.

    Args:
        a: First number.
        b: Second number.
    Returns:
        The arithmetic sum of *a* and *b*.
    """
    return a + b

def _parse_args(args):
    """Parse command‑line arguments.

    Expects two numeric values. If parsing fails or insufficient arguments are
    supplied, returns ``None``.
    """
    if len(args) >= 2:
        try:
            return float(args[0]), float(args[1])
        except ValueError:
            return None
    return None

if __name__ == "__main__":
    # Try to get numbers from command line first
    parsed = _parse_args(sys.argv[1:])
    if parsed:
        num1, num2 = parsed
    else:
        # Fallback to interactive input
        try:
            num1 = float(input("Enter the first number: "))
            num2 = float(input("Enter the second number: "))
        except Exception as e:
            print(f"Invalid input: {e}")
            sys.exit(1)
    result = add_numbers(num1, num2)
    print(f"The sum of {num1} and {num2} is {result}")
