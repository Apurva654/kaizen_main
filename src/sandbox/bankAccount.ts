import { add } from './utils';

export class BankAccount {
  private balance: number;

  constructor(initialBalance: number = 0) {
    if (initialBalance < 0) {
      throw new Error('Initial balance cannot be negative');
    }
    this.balance = initialBalance;
  }

  /**
   * Deposit a positive amount into the account.
   * @param amount Amount to deposit (must be > 0)
   */
  deposit(amount: number): void {
    if (amount <= 0) {
      throw new Error('Deposit amount must be greater than zero');
    }
    this.balance = add(this.balance, amount);
  }

  /**
   * Withdraw a positive amount from the account.
   * @param amount Amount to withdraw (must be > 0 and <= current balance)
   */
  withdraw(amount: number): void {
    if (amount <= 0) {
      throw new Error('Withdrawal amount must be greater than zero');
    }
    if (amount > this.balance) {
      throw new Error('Insufficient funds');
    }
    // Using add with a negative value to keep the utility function consistent
    this.balance = add(this.balance, -amount);
  }

  /**
   * Get the current account balance.
   */
  getBalance(): number {
    return this.balance;
  }
}
